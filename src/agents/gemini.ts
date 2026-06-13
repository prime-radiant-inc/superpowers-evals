import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import type { AgentConfig } from '../contracts/agent-config.ts';
import { envSnapshot, getEnv } from '../env.ts';
import type { CommandRunner } from './command-runner.ts';
import { type CodingAgent, ProvisionError, type RunHome } from './index.ts';

// Gemini-family provisioning (mirrors quorum/runner.py _seed_gemini_config):
// install the Superpowers CLI extension into an isolated GEMINI_CLI_HOME without
// invoking the model. Writes .gemini/settings.json (auth selectedType) and a
// mode-0600 .gemini-env carrying GEMINI_API_KEY, then shells out to
// `gemini extensions link ... --consent` + `gemini extensions list` through the
// injected CommandRunner and verifies the install manifests landed.

// Name of the secret env file written into GEMINI_CLI_HOME (Python:
// GEMINI_ENV_FILE_NAME). Shell-quoted like ClaudeAgent's .claude-env.
const GEMINI_ENV_FILE_NAME = '.gemini-env';

// Files that must exist under SUPERPOWERS_ROOT for the extension to install
// (Python: GEMINI_REQUIRED_SUPERPOWERS_FILES).
const GEMINI_REQUIRED_SUPERPOWERS_FILES: readonly string[] = [
  'gemini-extension.json',
  'GEMINI.md',
  'skills/using-superpowers/SKILL.md',
  'skills/using-superpowers/references/gemini-tools.md',
];

// Manifest files `gemini extensions link` writes on success (Python: the
// `metadata` list). Missing any of these means the link silently no-op'd.
const GEMINI_EXTENSION_MANIFESTS: readonly string[] = [
  join(
    '.gemini',
    'extensions',
    'superpowers',
    '.gemini-extension-install.json',
  ),
  join('.gemini', 'extensions', 'extension-enablement.json'),
  join('.gemini', 'extension_integrity.json'),
];

// The minimal .gemini/settings.json surface we read/write: a `security.auth`
// object whose selectedType we set. Everything else passes through untouched so
// the CLI can evolve the file (mirrors ClaudeAgent's passthrough parse).
const GeminiSettingsSchema = z
  .object({
    security: z
      .object({ auth: z.record(z.unknown()).optional() })
      .passthrough()
      .optional(),
  })
  .passthrough();

// Single-quote a value for a POSIX shell, escaping embedded single quotes.
// Mirrors ClaudeAgent's .claude-env quoting.
function shellSingleQuote(s: string): string {
  return `'${s.replaceAll("'", `'\\''`)}'`;
}

// Detect a `superpowers` row in `gemini extensions list` stdout (Python:
// _gemini_extension_list_shows_superpowers): a line beginning with
// `superpowers` (case-insensitive) optionally followed by whitespace or `(`.
function extensionListShowsSuperpowers(stdout: string): boolean {
  for (const line of stdout.split('\n')) {
    if (/^\s*superpowers(\s|\(|$)/i.test(line)) {
      return true;
    }
  }
  return false;
}

// Transcripts gemini would write under .gemini/tmp/**/chats/**/*.json* — none
// should exist after pure provisioning (Python: _gemini_transcripts). Returns
// the GEMINI_CLI_HOME-relative paths found.
function geminiTranscripts(configDir: string): string[] {
  const tmpDir = join(configDir, '.gemini', 'tmp');
  if (!existsSync(tmpDir)) {
    return [];
  }
  const found: string[] = [];
  const walk = (dir: string, inChats: boolean): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full, inChats || entry.name === 'chats');
      } else if (inChats && /\.json/.test(entry.name)) {
        found.push(full.slice(configDir.length + 1));
      }
    }
  };
  walk(tmpDir, false);
  return found.sort();
}

export class GeminiAgent implements CodingAgent {
  readonly config: AgentConfig;
  constructor(config: AgentConfig) {
    this.config = config;
  }

  provision(home: RunHome, runner: CommandRunner): Record<string, string> {
    const { configDir } = home;

    // SUPERPOWERS_ROOT must be set and carry the required extension files
    // (Python: _require_gemini_superpowers_root).
    const superpowersRoot = getEnv('SUPERPOWERS_ROOT') ?? '';
    if (!superpowersRoot) {
      throw new ProvisionError(
        'SUPERPOWERS_ROOT not set; cannot install Gemini Superpowers extension',
      );
    }
    const missingRoot = GEMINI_REQUIRED_SUPERPOWERS_FILES.filter(
      (rel) => !existsSync(join(superpowersRoot, rel)),
    );
    if (missingRoot.length > 0) {
      throw new ProvisionError(
        `SUPERPOWERS_ROOT is missing required Gemini Superpowers files: ${missingRoot.join(', ')}`,
      );
    }

    // GEMINI_API_KEY seeds the secret env file (Python: _write_gemini_env_file
    // raises before any subprocess if it is empty).
    const apiKey = getEnv('GEMINI_API_KEY') ?? '';
    if (!apiKey) {
      throw new ProvisionError(
        'GEMINI_API_KEY not set; cannot seed Gemini auth',
      );
    }

    mkdirSync(configDir, { recursive: true });

    // .gemini/settings.json: merge into any existing file and set
    // security.auth.selectedType = "gemini-api-key" (Python:
    // _write_gemini_settings). JSON.stringify with indent 2, no trailing newline.
    const settingsPath = join(configDir, '.gemini', 'settings.json');
    const settings = existsSync(settingsPath)
      ? GeminiSettingsSchema.parse(
          JSON.parse(readFileSync(settingsPath, 'utf8')),
        )
      : GeminiSettingsSchema.parse({});
    const security: Record<string, unknown> = { ...settings['security'] };
    const auth: Record<string, unknown> = {
      ...(security['auth'] as Record<string, unknown> | undefined),
    };
    auth['selectedType'] = 'gemini-api-key';
    security['auth'] = auth;
    const merged: Record<string, unknown> = { ...settings, security };
    mkdirSync(join(configDir, '.gemini'), { recursive: true });
    writeFileSync(settingsPath, JSON.stringify(merged, null, 2));

    // .gemini-env carries GEMINI_API_KEY for the launcher; mode 0600 (Python:
    // _write_gemini_env_file). Shell-quoted like ClaudeAgent's .claude-env.
    const envFile = join(configDir, GEMINI_ENV_FILE_NAME);
    writeFileSync(envFile, `GEMINI_API_KEY=${shellSingleQuote(apiKey)}\n`, {
      mode: 0o600,
    });

    // Env passed to the gemini subprocesses (Python: the `env` dict).
    const agentVars: Record<string, string> = {
      GEMINI_CLI_HOME: configDir,
      GEMINI_CLI_TRUST_WORKSPACE: 'true',
      GEMINI_DEFAULT_AUTH_TYPE: 'gemini-api-key',
    };
    const subprocessEnv = { ...envSnapshot(), ...agentVars };

    // gemini extensions link <SUPERPOWERS_ROOT> --consent
    const link = runner.run(
      'gemini',
      ['extensions', 'link', superpowersRoot, '--consent'],
      { cwd: configDir, env: subprocessEnv },
    );
    if (link.status !== 0) {
      throw new ProvisionError(
        `gemini extensions link failed (exit ${String(link.status)}); stderr: ${link.stderr.trim().slice(0, 300)}`,
      );
    }

    // gemini extensions list — verify superpowers appears.
    const listing = runner.run('gemini', ['extensions', 'list'], {
      cwd: configDir,
      env: subprocessEnv,
    });
    if (listing.status !== 0) {
      throw new ProvisionError(
        `gemini extensions list failed (exit ${String(listing.status)}); stderr: ${listing.stderr.trim().slice(0, 300)}`,
      );
    }
    if (!extensionListShowsSuperpowers(listing.stdout)) {
      throw new ProvisionError(
        'gemini extensions list did not show Superpowers extension',
      );
    }

    // The link must have written its install manifests (Python: `metadata`).
    const missingManifests = GEMINI_EXTENSION_MANIFESTS.filter(
      (rel) => !existsSync(join(configDir, rel)),
    );
    if (missingManifests.length > 0) {
      throw new ProvisionError(
        `gemini extension link completed but expected metadata files are missing: ${missingManifests.join(', ')}`,
      );
    }

    // Provisioning must not have run the model (Python: _gemini_transcripts).
    const transcripts = geminiTranscripts(configDir);
    if (transcripts.length > 0) {
      throw new ProvisionError(
        `gemini provisioning unexpectedly wrote transcripts before capture snapshot: ${transcripts.join(', ')}`,
      );
    }

    return { [this.config.agent_config_env]: configDir, ...agentVars };
  }
}
