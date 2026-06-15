import { existsSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import { getEnv } from '../env.ts';

// The runtime families the harness knows how to provision/normalize. An unknown
// family would otherwise fall through to the declarative DefaultAgent silently.
const KNOWN_RUNTIME_FAMILIES: ReadonlySet<string> = new Set([
  'antigravity',
  'claude',
  'codex',
  'copilot',
  'gemini',
  'kimi',
  'opencode',
  'pi',
]);

export const AgentConfigSchema = z.object({
  name: z.string(),
  runtime_family: z.string().optional(),
  binary: z.string(),
  agent_config_env: z.string(),
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
  max_time: z.string().optional(),
  project_prompt: z.string().optional(),
  model: z.string().optional(),
  // Scheduler keys: per-agent concurrency cap and launch spacing.
  max_concurrency: z.number().int().min(1).optional(),
  launch_spacing_seconds: z.number().min(0).optional(),
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

export function loadAgentConfig(
  codingAgentsDir: string,
  name: string,
): AgentConfig {
  const path = join(codingAgentsDir, `${name}.yaml`);
  const raw: unknown = parseYaml(readFileSync(path, 'utf8'));
  const cfg = AgentConfigSchema.parse(raw);

  // Loader validations, in order: name==stem, runtime_family known, claude
  // requires a non-blank model, then required_env present. Each is a
  // CodingAgentConfigError -> setup indeterminate.

  // name must equal the file stem (the name arg, since path is `${name}.yaml`).
  if (cfg.name !== name) {
    throw new CodingAgentConfigError(
      `${path}: name must match file stem; got name '${cfg.name}'`,
    );
  }

  // runtime_family defaults to the name and must be a known family.
  const family = cfg.runtime_family ?? cfg.name;
  if (!KNOWN_RUNTIME_FAMILIES.has(family)) {
    const known = [...KNOWN_RUNTIME_FAMILIES].sort().join(', ');
    throw new CodingAgentConfigError(
      `${path}: unknown runtime_family '${family}'; known: ${known}`,
    );
  }

  // A claude family requires a model; any declared model must not be blank
  // (avoids launching `claude --model ''`).
  if (family === 'claude' && cfg.model === undefined) {
    throw new CodingAgentConfigError(
      `${path}: claude runtime_family requires model`,
    );
  }
  if (cfg.model !== undefined && cfg.model.trim() === '') {
    throw new CodingAgentConfigError(`${path}: model must not be blank`);
  }

  // required_env must be set (a present-but-empty value counts as missing).
  const missingEnv = cfg.required_env.filter((v) => {
    const value = getEnv(v);
    return value === undefined || value === '';
  });
  if (missingEnv.length > 0) {
    throw new CodingAgentConfigError(
      `${path}: required env vars not set: ${missingEnv.join(', ')}`,
    );
  }

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
