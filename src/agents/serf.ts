import { mkdirSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { AgentConfig } from '../contracts/agent-config.ts';
import type { Credential } from '../contracts/credential.ts';
import { resolveApiKey, resolveApiKeyEnvName } from '../credentials/resolve.ts';
import {
  isSerfOpenRouterCampaignCredentialV1,
  SERF_OPENROUTER_V1_API_KEY_ENV,
} from '../credentials/serf-openrouter-profile.ts';
import { envSnapshot } from '../env.ts';
import type { CommandRunner } from './command-runner.ts';
import {
  type CodingAgent,
  ProvisionError,
  type RunHome,
  shellSingleQuote,
} from './index.ts';
import { writePrivateFileNoFollow } from './private-file.ts';
import { resolveSuperpowersRoot } from './superpowers.ts';

// The private per-run env file provision writes into the serf config dir: one
// line, `<SELECTED_NAME>='<value>'`, mode 0600. The launcher unsets the
// selected name, sources this file, and forwards ONLY the file-owned name —
// the gauntlet child env (which carries the grader credential) can never
// backfill it. Mirrors the claude .claude-env / codex codex-api.env pattern.
export const SERF_API_ENV_FILE_NAME = 'serf-api.env';

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

    // Kernel D2: the superpowers root is threaded via the home spec (ambient
    // env is consulted only on the legacy undefined path). none = the explicit
    // stock arm: no superpowers source validation (launcher --plugin-dir
    // threading is a Task-8 concern); missing preserves the pre-D2 hard-fail.
    const sp = resolveSuperpowersRoot(home);
    if (sp.kind === 'missing') {
      throw new ProvisionError(
        'SUPERPOWERS_ROOT not set; cannot point serf --plugin-dir at Superpowers',
      );
    }
    if (sp.kind === 'root') {
      const root = resolve(sp.root);
      const missing = SERF_REQUIRED_SUPERPOWERS_FILES.filter(
        (rel) => !isFile(join(root, rel)),
      );
      if (missing.length > 0) {
        throw new ProvisionError(
          `SUPERPOWERS_ROOT is missing required Superpowers plugin files: ${missing.join(', ')}`,
        );
      }
    }

    if (credential !== undefined) {
      if (credential.auth !== 'api-key') {
        throw new ProvisionError(
          `serf: auth '${credential.auth}' is not supported; use 'api-key'`,
        );
      }
      let resolution: ReturnType<typeof resolveApiKey>;
      try {
        resolution = resolveApiKey(credential, 'ANTHROPIC_API_KEY');
      } catch (e) {
        throw new ProvisionError(e instanceof Error ? e.message : String(e));
      }
      if (resolution.kind === 'env') {
        // Seed the selected credential into the private per-run env file the
        // launcher sources; the selected NAME is the same one the runner bakes
        // into the launcher as $SERF_API_KEY_ENV.
        const keyEnvName = resolveApiKeyEnvName(
          credential,
          'ANTHROPIC_API_KEY',
        );
        if (keyEnvName === null) {
          throw new ProvisionError(
            'serf: could not resolve the selected api key env name',
          );
        }
        writePrivateFileNoFollow(
          join(home.configDir, SERF_API_ENV_FILE_NAME),
          `${keyEnvName}=${shellSingleQuote(resolution.value)}\n`,
        );
      }

      if (credential.compat.tool_choice_auto_only === true) {
        if (!isSerfOpenRouterCampaignCredentialV1(credential)) {
          throw new ProvisionError(
            'serf: compat.tool_choice_auto_only requires the Serf OpenRouter campaign profile',
          );
        }
        const wireModel = credential.model.slice('openrouter/'.length);
        const body =
          'default = "openrouter"\n\n' +
          '[instances.openrouter]\n' +
          'type = "openrouter"\n' +
          `api_key = "$${SERF_OPENROUTER_V1_API_KEY_ENV}"\n\n` +
          `[instances.openrouter.models."${wireModel}".compat]\n` +
          'tool_choice_auto_only = true\n';
        writeFileSync(join(home.configDir, 'providers.toml'), body, {
          mode: 0o600,
        });
      }
    }

    // No extra env: the launcher sources the private serf-api.env and forwards
    // only the credential-selected key, loads the isolated per-run
    // SERF_PROVIDERS_CONFIG when provisioned, and bakes the
    // model/plugin-dir/export flags.
    return {};
  }
}
