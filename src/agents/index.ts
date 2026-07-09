import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { z } from 'zod';
import type { AgentConfig } from '../contracts/agent-config.ts';
import type { Credential } from '../contracts/credential.ts';
import type { OsTarget } from '../contracts/os-target.ts';
import {
  type ApiKeyResolution,
  resolveApiKey,
  resolveBedrockBearer,
} from '../credentials/resolve.ts';
import { AntigravityAgent } from './antigravity.ts';
import { WindowsClaudeAgent } from './claude-windows.ts';
import { CodexAgent } from './codex.ts';
import type { CommandRunner } from './command-runner.ts';
import { CopilotAgent } from './copilot.ts';
import { GeminiAgent } from './gemini.ts';
import { KimiAgent } from './kimi.ts';
import { OpenCodeAgent } from './opencode.ts';
import { PiAgent } from './pi.ts';
import { writePrivateFileNoFollow } from './private-file.ts';
import { SerfAgent } from './serf.ts';

/** The isolated home a run hands an agent to provision. Absence is undefined
 *  (§5.5): a missing skeleton root is undefined, never null. */
export interface RunHome {
  /** The agent's isolated config dir (<runHome>/<home_config_subdir>). */
  readonly configDir: string;
  /** The dir the coding agent runs in (resolves project-trust paths). */
  readonly workdir: string;
  /** Root holding `<runtime>-home-skeleton/`, or undefined when none is seeded. */
  readonly skeletonRoot: string | undefined;
}

/** Behavior contract for a coding agent (§5.4): config plus a single
 *  provisioning motion that seeds the isolated config dir and returns the extra
 *  environment gauntlet must pass into the agent CLI. */
export interface CodingAgent {
  readonly config: AgentConfig;
  // Seed the isolated agent-config dir; return extra env to pass to gauntlet.
  // `runner` is the subprocess seam for agents whose provisioning shells out
  // (codex/gemini/opencode/kimi/antigravity). Declarative adapters
  // (DefaultAgent, ClaudeAgent) ignore it — a 1-arg method satisfies this
  // 2-arg signature via TS method bivariance, so they need no change.
  // `credential` is the resolved Credential (B2-B5 adapters consume it;
  // declarative adapters ignore it via method bivariance).
  provision(
    home: RunHome,
    runner: CommandRunner,
    credential?: Credential,
  ): Record<string, string>;
}

// Thrown by an agent's provision() when setup fails (missing required input, a
// non-zero provisioning subprocess, a missing staged plugin file). The runner
// maps it to a 'setup'-stage indeterminate verdict. Defined here, not in
// runner/index.ts, so adapters import it without a runner<->agents cycle.
export class ProvisionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProvisionError';
  }
}

/** Basename of the per-run Claude auth env file ClaudeAgent.provision writes
 *  under configDir. The runner derives the $CLAUDE_ENV_FILE substitution from
 *  this deterministic path, so the constant is the single source of truth for
 *  both sides. */
export const CLAUDE_ENV_FILE_NAME = '.claude-env';

/** The minimal `.claude.json` surface quorum reads/writes: an object whose
 *  `projects` map (when present) is itself an object. Everything else passes
 *  through untouched so claude can evolve the file without breaking us. */
const ClaudeJsonSchema = z
  .object({ projects: z.record(z.unknown()).optional() })
  .passthrough();

/** Declarative agents whose provisioning is fully driven by YAML. Just creates
 *  the isolated config dir; the agent finds it via its $HOME default. */
class DefaultAgent implements CodingAgent {
  readonly config: AgentConfig;
  constructor(config: AgentConfig) {
    this.config = config;
  }
  provision(home: RunHome): Record<string, string> {
    mkdirSync(home.configDir, { recursive: true });
    return {};
  }
}

/** Claude-family provisioning: create the config dir, trust the run's project so
 *  the CLI never prompts, and write a mode-0600 .claude-env carrying the API key
 *  for the launcher. No onboarding skeleton is seeded — recent claude boots on
 *  API-key auth + the trust block (it runs/auto-completes onboarding each run). */
class ClaudeAgent implements CodingAgent {
  readonly config: AgentConfig;
  constructor(config: AgentConfig) {
    this.config = config;
  }
  provision(
    home: RunHome,
    _runner: CommandRunner,
    credential?: Credential,
  ): Record<string, string> {
    const { configDir, workdir } = home;
    mkdirSync(configDir, { recursive: true });

    const claudeJsonPath = join(configDir, '.claude.json');

    // Trust the run's project so claude doesn't prompt. No onboarding skeleton
    // is needed — recent claude boots on API-key auth + this trust block and
    // auto-completes onboarding each run. (IS_DEMO=1 is deliberately NOT set: it
    // skips the first-run flow that activates auth on a fresh config, producing
    // "Not logged in".) Parse any existing file (boundary §4.1) rather than
    // asserting its shape.
    const claudeJson = existsSync(claudeJsonPath)
      ? ClaudeJsonSchema.parse(JSON.parse(readFileSync(claudeJsonPath, 'utf8')))
      : ClaudeJsonSchema.parse({});
    const projects: Record<string, unknown> = { ...claudeJson.projects };
    projects[resolve(workdir)] = {
      hasTrustDialogAccepted: true,
      projectOnboardingSeenCount: 1,
      hasClaudeMdExternalIncludesApproved: true,
      hasClaudeMdExternalIncludesWarningShown: true,
    };
    writeFileSync(
      claudeJsonPath,
      `${JSON.stringify({ ...claudeJson, projects }, null, 2)}\n`,
    );

    // Seed the per-run auth when a credential with api-key auth is present.
    // Resolves the key via the credential (honoring api_key_env override), then
    // writes the mode-0600 .claude-env the launcher sources and records the
    // API-key approval fingerprint so claude doesn't prompt "Detected a custom
    // API key…" headless.
    if (credential !== undefined && credential.auth === 'api-key') {
      let resolution: ApiKeyResolution;
      try {
        resolution = resolveApiKey(credential, 'ANTHROPIC_API_KEY');
      } catch (e) {
        throw new ProvisionError(e instanceof Error ? e.message : String(e));
      }
      if (resolution.kind !== 'env') {
        throw new ProvisionError(
          'claude: could not resolve api key from credential',
        );
      }
      seedClaudeAuth(configDir, claudeJsonPath, resolution.value);
    } else if (credential !== undefined && credential.api === 'mantle') {
      try {
        seedClaudeMantle(configDir, credential);
      } catch (e) {
        throw new ProvisionError(e instanceof Error ? e.message : String(e));
      }
    }
    return {};
  }
}

/** Seed all three claude auth artifacts for a run:
 *  1. `.claude-env` (mode 0600 via O_NOFOLLOW writer) — sourced by the launcher
 *     to carry ANTHROPIC_API_KEY into the agent process.
 *  2. `approveClaudeApiKey` — writes the key fingerprint into customApiKeyResponses
 *     so claude doesn't prompt "Detected a custom API key…" headless.
 *  3. `api-key-helper.sh` (mode 0700) + `settings.json` with `apiKeyHelper` —
 *     the helper sits above the keychain in claude's auth precedence, so on macOS
 *     the launcher can strip ANTHROPIC_API_KEY from the agent env (preventing the
 *     "use this key?" TUI prompt triggered by a detected env key) while the helper
 *     still delivers the key without reading the login keychain. */
function seedClaudeAuth(
  configDir: string,
  claudeJsonPath: string,
  apiKey: string,
): void {
  // Step 1: mode-0600 env file the launcher sources.
  const envFile = join(configDir, CLAUDE_ENV_FILE_NAME);
  writePrivateFileNoFollow(
    envFile,
    `ANTHROPIC_API_KEY=${shellSingleQuote(apiKey)}\n`,
  );
  // Step 2: approval fingerprint so the "Detected a custom API key" prompt never fires.
  approveClaudeApiKey(claudeJsonPath, apiKey);
  // Step 3: apiKeyHelper auth — keychain-free interactive auth. On macOS the env-key
  // path makes the interactive (TUI) agent read the login keychain at startup
  // (a Keychain/"use this API key?" prompt per fresh throwaway $HOME). In
  // claude's auth precedence apiKeyHelper sits ABOVE the keychain and is a
  // configured helper (not a "detected env API key"), so it authenticates
  // with no keychain read and no approval prompt. The launcher strips
  // ANTHROPIC_API_KEY from the agent so this helper — not the env key — is
  // what claude resolves; the key is embedded in the mode-0700, run-dir
  // scoped helper because the agent's env has none.
  const helperPath = join(configDir, 'api-key-helper.sh');
  writePrivateFileNoFollow(
    helperPath,
    `#!/bin/sh\nprintf '%s' ${shellSingleQuote(apiKey)}\n`,
  );
  chmodSync(helperPath, 0o700);
  const settingsPath = join(configDir, 'settings.json');
  const settings: Record<string, unknown> = existsSync(settingsPath)
    ? (JSON.parse(readFileSync(settingsPath, 'utf8')) as Record<
        string,
        unknown
      >)
    : {};
  settings['apiKeyHelper'] = helperPath;
  writeFileSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`);
}

/** Seed the run-scoped .claude-env for the Bedrock/Mantle path: enable Mantle +
 *  region + the bearer. Deliberately does NOT seed ANTHROPIC_API_KEY, the
 *  apiKeyHelper, or the approval fingerprint — none apply on Bedrock. The vars
 *  live ONLY in this file (behind the launcher's env -i wall); provision returns
 *  {} so they never overlay the gauntlet subprocess. */
export function seedClaudeMantle(
  configDir: string,
  credential: Credential,
): void {
  const region = credential.region;
  if (region === undefined || region === '') {
    throw new Error('claude mantle credential requires a region');
  }
  const bearer = resolveBedrockBearer(credential);
  const envFile = join(configDir, CLAUDE_ENV_FILE_NAME);
  writePrivateFileNoFollow(
    envFile,
    `CLAUDE_CODE_USE_MANTLE=1\nAWS_REGION=${shellSingleQuote(region)}\nAWS_BEARER_TOKEN_BEDROCK=${shellSingleQuote(bearer)}\n`,
  );
}

/** Record a per-config approval for the run's API key so Claude Code does not
 *  prompt "Detected a custom API key… use this key?" when launched headless
 *  with ANTHROPIC_API_KEY. The fingerprint is the key's last 20 chars; it is
 *  added to customApiKeyResponses.approved (idempotently) and scrubbed from
 *  rejected. */
function approveClaudeApiKey(configPath: string, apiKey: string): void {
  const config: Record<string, unknown> = existsSync(configPath)
    ? (JSON.parse(readFileSync(configPath, 'utf8')) as Record<string, unknown>)
    : {};
  const existing = config['customApiKeyResponses'];
  const responses: Record<string, unknown> =
    typeof existing === 'object' && existing !== null
      ? (existing as Record<string, unknown>)
      : {};
  config['customApiKeyResponses'] = responses;
  const fingerprint = apiKey.slice(-20);

  const approvedRaw = responses['approved'];
  const approved: string[] = Array.isArray(approvedRaw)
    ? (approvedRaw as string[])
    : [];
  responses['approved'] = approved;
  if (!approved.includes(fingerprint)) {
    approved.push(fingerprint);
  }

  const rejectedRaw = responses['rejected'];
  responses['rejected'] = Array.isArray(rejectedRaw)
    ? (rejectedRaw as string[]).filter((item) => item !== fingerprint)
    : [];

  writeFileSync(configPath, JSON.stringify(config));
}

/** Single-quote a value for a POSIX shell, escaping embedded single quotes.
 *  Exported for reuse by the runner's context-dir _SH substitutions. */
export function shellSingleQuote(s: string): string {
  return `'${s.replaceAll("'", `'\\''`)}'`;
}

// name -> custom adapter factory. Each dialect with provisioning beyond the
// declarative default registers here; everything else falls through to
// DefaultAgent.
const CUSTOM_AGENTS: Readonly<
  Record<string, (config: AgentConfig) => CodingAgent>
> = {
  codex: (config) => new CodexAgent(config),
  gemini: (config) => new GeminiAgent(config),
  pi: (config) => new PiAgent(config),
  copilot: (config) => new CopilotAgent(config),
  opencode: (config) => new OpenCodeAgent(config),
  kimi: (config) => new KimiAgent(config),
  antigravity: (config) => new AntigravityAgent(config),
  serf: (config) => new SerfAgent(config),
};

/** Resolve the agent implementation for a config.
 *
 *  - `os === 'linux'` (default) → today's resolution: ClaudeAgent for the
 *    claude family, registered custom adapters by name, else DefaultAgent.
 *  - `os === 'windows'` + family `claude` → WindowsClaudeAgent using
 *    `osTarget.remote`.
 *  - `os !== 'linux'` + any other family → throws ProvisionError.
 *  - `os === 'windows'` + family `claude` + `credentialApi === 'mantle'` →
 *    throws ProvisionError. WindowsClaudeAgent.provision ignores the resolved
 *    credential (it reads ANTHROPIC_API_KEY and bakes config.model), so a
 *    Mantle credential would silently mis-run/mis-bill instead of using
 *    Bedrock.
 *
 *  The `os`, `osTarget`, and `credentialApi` parameters default so existing
 *  `resolveAgent(cfg)` call sites keep compiling unchanged. */
export function resolveAgent(
  config: AgentConfig,
  os: string = 'linux',
  osTarget?: OsTarget,
  credentialApi?: string,
): CodingAgent {
  if (os !== 'linux') {
    const family = config.runtime_family ?? config.name;
    if (family === 'claude') {
      if (credentialApi === 'mantle') {
        throw new ProvisionError(
          `agent ${config.name}: Windows Claude does not support the Mantle credential; use --credential opus`,
        );
      }
      if (osTarget === undefined || osTarget.remote === undefined) {
        throw new ProvisionError(
          `agent ${config.name}: windows provisioner requires osTarget.remote`,
        );
      }
      return new WindowsClaudeAgent(config, osTarget.remote);
    }
    throw new ProvisionError(`agent ${config.name} has no ${os} provisioner`);
  }
  const name = config.runtime_family ?? config.name;
  if (name === 'claude') {
    return new ClaudeAgent(config);
  }
  const factory = CUSTOM_AGENTS[name];
  if (factory !== undefined) {
    return factory(config);
  }
  return new DefaultAgent(config);
}
