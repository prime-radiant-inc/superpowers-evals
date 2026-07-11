import { mkdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { AgentConfig } from '../contracts/agent-config.ts';
import type { Credential } from '../contracts/credential.ts';
import { resolveApiKey } from '../credentials/resolve.ts';
import { envSnapshot, getEnv } from '../env.ts';
import type { CommandRunner } from './command-runner.ts';
import { type CodingAgent, ProvisionError, type RunHome } from './index.ts';

// Serf provisioning adapter. Like the Claude adapter, serf loads Superpowers by
// pointing `--plugin-dir` straight at SUPERPOWERS_ROOT (no staging into the
// isolated home), so provision() is deliberately light: create the isolated
// config dir, fail fast when the binary is missing or SUPERPOWERS_ROOT is
// misconfigured, and let the launcher wire the credential-selected model and
// API-key name. serf re-seeds its provider instances from that selected key
// because the launcher points SERF_PROVIDERS_CONFIG at a fresh per-run path.

// Plugin files SUPERPOWERS_ROOT must contain for serf to load Superpowers and
// auto-trigger skills (the SessionStart bootstrap + the two skills the
// acceptance test exercises).
const SERF_REQUIRED_SUPERPOWERS_FILES: readonly string[] = [
  '.claude-plugin/plugin.json',
  'hooks/hooks.json',
  'hooks/run-hook.cmd',
  'hooks/session-start',
  'skills/using-superpowers/SKILL.md',
  'skills/brainstorming/SKILL.md',
];

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

// Real PATH lookup. Bun.which resolves an actual PATH entry; a `command -v`
// probe ENOENTs through the no-shell spawn seam and false-fails on Linux. Matches
// the copilot/opencode adapters.
function binaryOnPath(binary: string): boolean {
  return Bun.which(binary, { PATH: envSnapshot()['PATH'] ?? '' }) !== null;
}

export class SerfAgent implements CodingAgent {
  readonly config: AgentConfig;

  constructor(config: AgentConfig) {
    // erasableSyntaxOnly forbids a parameter property; assign in the body.
    this.config = config;
  }

  provision(
    home: RunHome,
    _runner: CommandRunner,
    credential?: Credential,
  ): Record<string, string> {
    mkdirSync(home.configDir, { recursive: true });
    // Pre-create the ATIF export dir so the pre-run capture snapshot sees a
    // clean, empty dir (serf's --export-atif also MkdirAll's it, but the
    // snapshot is taken before serf runs).
    mkdirSync(join(home.configDir, 'exports'), { recursive: true });

    if (!binaryOnPath(this.config.binary)) {
      throw new ProvisionError(
        `${this.config.binary} not found on PATH; cannot run serf evals`,
      );
    }

    const superpowersRoot = getEnv('SUPERPOWERS_ROOT') ?? '';
    if (superpowersRoot === '') {
      throw new ProvisionError(
        'SUPERPOWERS_ROOT not set; cannot point serf --plugin-dir at Superpowers',
      );
    }
    const root = resolve(superpowersRoot);
    const missing = SERF_REQUIRED_SUPERPOWERS_FILES.filter(
      (rel) => !isFile(join(root, rel)),
    );
    if (missing.length > 0) {
      throw new ProvisionError(
        `SUPERPOWERS_ROOT is missing required Superpowers plugin files: ${missing.join(', ')}`,
      );
    }

    if (credential !== undefined) {
      if (credential.auth !== 'api-key') {
        throw new ProvisionError(
          `serf: auth '${credential.auth}' is not supported; use 'api-key'`,
        );
      }
      try {
        resolveApiKey(credential, 'ANTHROPIC_API_KEY');
      } catch (e) {
        throw new ProvisionError(e instanceof Error ? e.message : String(e));
      }
    }

    // No extra env: the launcher forwards only the credential-selected key,
    // sets a fresh SERF_PROVIDERS_CONFIG, and bakes the model/plugin-dir/export-atif flags.
    return {};
  }
}
