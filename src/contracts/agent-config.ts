import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import { getEnv } from '../env.ts';
import { type RemoteConfig, RemoteConfigSchema } from './os-target.ts';

export { type RemoteConfig, RemoteConfigSchema };

// The runtime families the harness knows how to provision/normalize. An unknown
// family would otherwise fall through to the declarative DefaultAgent silently.
const KNOWN_RUNTIME_FAMILIES: ReadonlySet<string> = new Set([
  'antigravity',
  'claude',
  'codex',
  'copilot',
  'gemini',
  'hermes',
  'kimi',
  'opencode',
  'pi',
  'serf',
]);

export const AgentConfigSchema = z.object({
  name: z.string(),
  runtime_family: z.string().optional(),
  binary: z.string(),
  session_log_dir: z.string(),
  session_log_glob: z.string(),
  normalizer: z.string(),
  // Throwaway-$HOME config collapse (required): the agent's config dir is rooted
  // UNDER the per-run throwaway home (<runHome>/<home_config_subdir>), so the
  // agent finds its config via its $HOME default and the launcher need not set
  // the config-dir env var. "." means the home itself (the var was HOME-like,
  // e.g. gemini/opencode). See agentConfigDir().
  home_config_subdir: z.string(),
  required_env: z.array(z.string()).default([]),
  // When set, the resolved binary's --version line must contain this string or
  // the run fails at setup. Guards against silent PATH-binary drift: a full
  // codex battery once ran a stale 0.144.4 from PATH while the analysis
  // assumed current, and only provenance (which nothing asserted on) knew.
  pin_cli_version: z.string().optional(),
  max_time: z.string().optional(),
  project_prompt: z.string().optional(),
  model: z.string().optional(),
  default_credential: z.string().optional(),
  os_support: z.array(z.string()).default(['linux']),
});
export type AgentConfig = z.infer<typeof AgentConfigSchema>;

/**
 * Resolve the agent's isolated config dir, rooted under the per-run throwaway
 * home `runHomeDir` at `home_config_subdir` (the agent finds it via its $HOME
 * default, so the launcher needs no config-dir env var). `"."` means the home
 * itself (a HOME-like var, e.g. gemini/opencode).
 */
export function agentConfigDir(cfg: AgentConfig, runHomeDir: string): string {
  return join(runHomeDir, cfg.home_config_subdir);
}

// Thrown when a coding-agent YAML is structurally valid but a referenced file
// cannot be resolved (e.g. the project_prompt-existence leg). The runner maps it
// to a setup-stage indeterminate via errorStage.
export class CodingAgentConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CodingAgentConfigError';
  }
}

// First line of `<binary> --version`, or null when the binary is missing,
// exits nonzero, or exceeds timeoutMs (some CLIs — hermes — run a synchronous
// network update check inside --version and can wedge in an egress-restricted
// container; a timeout maps to the same null → config-error path). Kept here
// (not imported from runner/provenance) so contracts stays free of runner
// imports. Exported for direct testing.
export function probeCliVersionLine(
  binary: string,
  timeoutMs = 30_000,
): string | null {
  const p = spawnSync(binary, ['--version'], {
    encoding: 'utf8',
    timeout: timeoutMs,
  });
  if (p.error || p.status !== 0) {
    return null;
  }
  const line = (p.stdout ?? '').split('\n')[0]?.trim() ?? '';
  return line === '' ? null : line;
}

/**
 * Enforce `pin_cli_version`: when the config pins a version, the binary's
 * --version line must contain the pinned string. Absent pin → no probe.
 * A mismatch or an unprobeable binary throws CodingAgentConfigError (mapped
 * by the runner to a setup-stage indeterminate — an environment error, not a
 * result).
 */
export function enforceCliVersionPin(
  path: string,
  cfg: AgentConfig,
  probeVersion: (binary: string) => string | null = probeCliVersionLine,
): void {
  const pin = cfg.pin_cli_version;
  if (pin === undefined) {
    return;
  }
  const actual = probeVersion(cfg.binary);
  if (actual === null) {
    throw new CodingAgentConfigError(
      `${path}: pin_cli_version '${pin}' set but '${cfg.binary} --version' is unavailable — cannot verify the binary under test`,
    );
  }
  if (!actual.includes(pin)) {
    throw new CodingAgentConfigError(
      `${path}: pinned CLI version '${pin}' but '${cfg.binary} --version' reports '${actual}' — refusing to run against an unpinned binary`,
    );
  }
}

function readAgentConfigFile(
  codingAgentsDir: string,
  name: string,
): {
  readonly path: string;
  readonly cfg: AgentConfig;
} {
  const path = join(codingAgentsDir, `${name}.yaml`);
  const raw: unknown = parseYaml(readFileSync(path, 'utf8'));
  return { path, cfg: AgentConfigSchema.parse(raw) };
}

export function agentRuntimeFamily(
  cfg: Pick<AgentConfig, 'name' | 'runtime_family'>,
): string {
  return cfg.runtime_family ?? cfg.name;
}

function validateAgentConfigStatic(
  path: string,
  cfg: AgentConfig,
  name: string,
): string {
  // name must equal the file stem (the name arg, since path is `${name}.yaml`).
  if (cfg.name !== name) {
    throw new CodingAgentConfigError(
      `${path}: name must match file stem; got name '${cfg.name}'`,
    );
  }

  // runtime_family defaults to the name and must be a known family.
  const family = agentRuntimeFamily(cfg);
  if (!KNOWN_RUNTIME_FAMILIES.has(family)) {
    const known = [...KNOWN_RUNTIME_FAMILIES].sort().join(', ');
    throw new CodingAgentConfigError(
      `${path}: unknown runtime_family '${family}'; known: ${known}`,
    );
  }

  // A claude family requires a default_credential (the credential supplies the
  // model); any declared model must not be blank (avoids `claude --model ''`).
  if (family === 'claude' && cfg.default_credential === undefined) {
    throw new CodingAgentConfigError(
      `${path}: claude runtime_family requires default_credential`,
    );
  }
  if (cfg.model !== undefined && cfg.model.trim() === '') {
    throw new CodingAgentConfigError(`${path}: model must not be blank`);
  }

  return family;
}

function resolveProjectPrompt(path: string, cfg: AgentConfig): AgentConfig {
  // Resolve project_prompt relative to the YAML file's dir to an absolute path
  // and require it to exist. Gauntlet's --project-prompt needs an absolute,
  // existing file; the raw "claude.project-prompt.md" alone fails ("file not
  // found"). Overwrite the parsed field with the resolved absolute path so
  // invokeGauntlet passes it.
  if (cfg.project_prompt !== undefined && cfg.project_prompt !== '') {
    const candidate = resolve(dirname(path), cfg.project_prompt);
    if (!existsSync(candidate) || !statSync(candidate).isFile()) {
      throw new CodingAgentConfigError(
        `${path}: project_prompt path does not exist: ${candidate}`,
      );
    }
    return { ...cfg, project_prompt: candidate };
  }
  return cfg;
}

/** Parse + statically validate an agent config from its SOURCE text;
 *  `origin` names where the bytes came from in error messages (a file path,
 *  or an object-store address like `coding-agents/claude.yaml@<sha>`). No
 *  project_prompt resolution — that needs a real tree and belongs to the
 *  path-based loaders. */
export function parseAgentConfigForValidation(
  source: string,
  origin: string,
  name: string,
): AgentConfig {
  const cfg = AgentConfigSchema.parse(parseYaml(source));
  validateAgentConfigStatic(origin, cfg, name);
  return cfg;
}

export function loadAgentConfigForValidation(
  codingAgentsDir: string,
  name: string,
): AgentConfig {
  const path = join(codingAgentsDir, `${name}.yaml`);
  const cfg = parseAgentConfigForValidation(
    readFileSync(path, 'utf8'),
    path,
    name,
  );
  return resolveProjectPrompt(path, cfg);
}

export function loadAgentConfig(
  codingAgentsDir: string,
  name: string,
  opts?: {
    /** Effective-environment reader for the required_env check: the runner
     *  validates against the run's threaded superpowers mode, not ambient
     *  env. Unset → ambient reads, unchanged. */
    readonly env?: (key: string) => string | undefined;
    /** Required names the caller suppresses (SUPERPOWERS_ROOT under an
     *  explicit {mode:'none'} spec — absent-of-env is not itself the none
     *  signal). */
    readonly suppressRequired?: readonly string[];
  },
): AgentConfig {
  const { path, cfg } = readAgentConfigFile(codingAgentsDir, name);

  // Loader validations, in order: name==stem, runtime_family known, claude
  // requires default_credential (a declared model must not be blank), then
  // required_env present. Each is a CodingAgentConfigError -> setup
  // indeterminate.
  validateAgentConfigStatic(path, cfg, name);

  // required_env must be set (a present-but-empty value counts as missing),
  // resolved against the caller's effective environment when one is supplied
  // and the ambient env otherwise. This is the single required_env
  // validation — callers do not re-check it.
  const envReader = opts?.env ?? getEnv;
  const suppressed = new Set(opts?.suppressRequired ?? []);
  const missingEnv = cfg.required_env
    .filter((v) => !suppressed.has(v))
    .filter((v) => {
      const value = envReader(v);
      return value === undefined || value === '';
    });
  if (missingEnv.length > 0) {
    throw new CodingAgentConfigError(
      `${path}: required env vars not set: ${missingEnv.join(', ')}`,
    );
  }

  enforceCliVersionPin(path, cfg);

  return resolveProjectPrompt(path, cfg);
}

/**
 * Replace `$VAR` and `${VAR}` occurrences from a map, and `$$` with a literal
 * `$`. Unknown vars and a lone `$` are left intact.
 */
export function substituteEnv(
  text: string,
  vars: Readonly<Record<string, string>>,
): string {
  return text.replace(
    /\$(?:(\$)|\{([A-Za-z_][A-Za-z0-9_]*)\}|([A-Za-z_][A-Za-z0-9_]*))/g,
    (whole, escaped: string | undefined, braced?: string, bare?: string) => {
      if (escaped !== undefined) {
        return '$';
      }
      const key = braced ?? bare;
      if (key === undefined) {
        return whole;
      }
      const value = vars[key];
      return value !== undefined ? value : whole;
    },
  );
}

// Expand a leading ~ to the user's home dir (the common case; a non-leading ~ is
// left untouched).
function expanduser(path: string): string {
  if (path === '~') {
    return homedir();
  }
  if (path.startsWith('~/')) {
    return join(homedir(), path.slice(2));
  }
  return path;
}

/**
 * Resolve a session_log_dir template: substitute env vars, then expand a leading
 * ~. Literal paths pass through.
 */
export function resolveSessionLogDir(
  template: string,
  vars: Readonly<Record<string, string>>,
): string {
  return expanduser(substituteEnv(template, vars));
}
