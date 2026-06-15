import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { z } from 'zod';
import type { AgentConfig } from '../contracts/agent-config.ts';
import { getEnv } from '../env.ts';
import { AntigravityAgent } from './antigravity.ts';
import { CodexAgent } from './codex.ts';
import type { CommandRunner } from './command-runner.ts';
import { CopilotAgent } from './copilot.ts';
import { GeminiAgent } from './gemini.ts';
import { KimiAgent } from './kimi.ts';
import { OpenCodeAgent } from './opencode.ts';
import { PiAgent } from './pi.ts';
import { writePrivateFileNoFollow } from './private-file.ts';

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
  provision(home: RunHome, runner: CommandRunner): Record<string, string>;
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
  provision(home: RunHome): Record<string, string> {
    const { configDir, workdir } = home;
    mkdirSync(configDir, { recursive: true });

    const claudeJsonPath = join(configDir, '.claude.json');

    // Trust the run's project so claude doesn't prompt. IS_DEMO=1 (set by the
    // launcher) skips first-run onboarding, so no hand-seeded onboarding skeleton
    // is needed; the workspace-trust state still lives in .claude.json. Parse any
    // existing file (boundary §4.1) rather than asserting its shape.
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

    // When ANTHROPIC_API_KEY is a required env, seed the per-run auth: write the
    // mode-0600 .claude-env the launcher sources, and record the API-key
    // approval fingerprint so claude doesn't prompt "Detected a custom API
    // key…" headless. Both are gated on ANTHROPIC_API_KEY being a required env.
    if (this.config.required_env.includes('ANTHROPIC_API_KEY')) {
      // Read the key through the one sanctioned env module (§6.5), never
      // process.env. Empty means unset; fail at the setup stage rather than
      // silently writing a blank key.
      const apiKey = getEnv('ANTHROPIC_API_KEY') ?? '';
      if (apiKey === '') {
        throw new ProvisionError(
          'ANTHROPIC_API_KEY not set; cannot seed Claude auth',
        );
      }
      const envFile = join(configDir, CLAUDE_ENV_FILE_NAME);
      // The mode-0600 secret env file goes through the shared O_NOFOLLOW writer
      // so a pre-placed symlink at the destination cannot redirect the API key.
      writePrivateFileNoFollow(
        envFile,
        `ANTHROPIC_API_KEY=${shellSingleQuote(apiKey)}\n`,
      );
      approveClaudeApiKey(claudeJsonPath, apiKey);
    }
    return {};
  }
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
};

/** Resolve the agent implementation for a config: the Claude provisioner when
 *  the runtime family (or, absent that, the name) is `claude`; a registered
 *  custom adapter when the name matches; else the declarative default. */
export function resolveAgent(config: AgentConfig): CodingAgent {
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
