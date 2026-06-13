import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
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

/** The isolated home a run hands an agent to provision. Absence is undefined
 *  (§5.5): a missing skeleton root is undefined, never null. */
export interface RunHome {
  /** The agent_config_env dir (e.g. CLAUDE_CONFIG_DIR / CODEX_HOME). */
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
 *  under configDir (mirrors quorum CLAUDE_ENV_FILE_NAME = ".claude-env"). The
 *  runner derives the $CLAUDE_ENV_FILE substitution from this deterministic
 *  path, so the constant is the single source of truth for both sides. */
export const CLAUDE_ENV_FILE_NAME = '.claude-env';

/** The minimal `.claude.json` surface quorum reads/writes: an object whose
 *  `projects` map (when present) is itself an object. Everything else passes
 *  through untouched so claude can evolve the file without breaking us. */
const ClaudeJsonSchema = z
  .object({ projects: z.record(z.unknown()).optional() })
  .passthrough();

/** Declarative agents whose provisioning is fully driven by YAML (Spec 2
 *  widens this set). Just creates the isolated config dir and points the
 *  agent_config_env at it. */
class DefaultAgent implements CodingAgent {
  readonly config: AgentConfig;
  constructor(config: AgentConfig) {
    this.config = config;
  }
  provision(home: RunHome): Record<string, string> {
    mkdirSync(home.configDir, { recursive: true });
    return { [this.config.agent_config_env]: home.configDir };
  }
}

/** Claude-family provisioning: seed the skeleton (or an empty dir), trust the
 *  run's project so the CLI never prompts, and write a mode-0600 .claude-env
 *  carrying the API key for the launcher. */
class ClaudeAgent implements CodingAgent {
  readonly config: AgentConfig;
  constructor(config: AgentConfig) {
    this.config = config;
  }
  provision(home: RunHome): Record<string, string> {
    const { configDir, workdir, skeletonRoot } = home;
    const family = this.config.runtime_family ?? 'claude';
    const skel =
      skeletonRoot !== undefined
        ? join(skeletonRoot, `${family}-home-skeleton`)
        : undefined;
    if (skel !== undefined && existsSync(skel)) {
      cpSync(skel, configDir, { recursive: true });
    } else {
      mkdirSync(configDir, { recursive: true });
    }

    // Trust the project so claude doesn't prompt. Parse the existing file
    // (boundary §4.1) rather than asserting its shape.
    const claudeJsonPath = join(configDir, '.claude.json');
    const claudeJson = existsSync(claudeJsonPath)
      ? ClaudeJsonSchema.parse(JSON.parse(readFileSync(claudeJsonPath, 'utf8')))
      : ClaudeJsonSchema.parse({});
    const projects: Record<string, unknown> = { ...claudeJson.projects };
    projects[resolve(workdir)] = {
      hasTrustDialogAccepted: true,
      projectOnboardingSeenCount: 1,
      hasClaudeMdExternalIncludesApproved: true,
    };
    writeFileSync(
      claudeJsonPath,
      `${JSON.stringify({ ...claudeJson, projects }, null, 2)}\n`,
    );

    // .claude-env carries the API key for the launcher; mode 0600 (§6.4). Read
    // the key through the one sanctioned env module (§6.5), never process.env.
    const apiKey = getEnv('ANTHROPIC_API_KEY') ?? '';
    const envFile = join(configDir, CLAUDE_ENV_FILE_NAME);
    writeFileSync(envFile, `ANTHROPIC_API_KEY=${shellSingleQuote(apiKey)}\n`, {
      mode: 0o600,
    });
    return { [this.config.agent_config_env]: configDir };
  }
}

/** Single-quote a value for a POSIX shell, escaping embedded single quotes.
 *  Exported for reuse by the runner's context-dir _SH substitutions (mirrors
 *  quorum/runner.py:_shell_single_quote). */
export function shellSingleQuote(s: string): string {
  return `'${s.replaceAll("'", `'\\''`)}'`;
}

// name -> custom adapter factory (Spec 2). Each dialect with provisioning beyond
// the declarative default registers here; everything else falls through to
// DefaultAgent. Mirrors the per-name dispatch in quorum/runner.py.
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
