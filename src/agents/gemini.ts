import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
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

// Gemini auth-type values (Python: GEMINI_AUTH_TYPE_{API_KEY,OAUTH},
// GEMINI_AUTH_TYPES). api-key mode seeds GEMINI_API_KEY; oauth-personal copies
// the local OAuth credential files instead.
const GEMINI_AUTH_TYPE_API_KEY = 'gemini-api-key';
const GEMINI_AUTH_TYPE_OAUTH = 'oauth-personal';
const GEMINI_AUTH_TYPES: readonly string[] = [
  GEMINI_AUTH_TYPE_API_KEY,
  GEMINI_AUTH_TYPE_OAUTH,
];

// OAuth credential files the adapter copies from GEMINI_OAUTH_HOME (Python:
// _copy_gemini_oauth_credentials).
const GEMINI_OAUTH_CREDENTIAL_FILES: readonly string[] = [
  'oauth_creds.json',
  'google_accounts.json',
];

// Resolve the requested Gemini auth type (Python: _gemini_auth_type). An empty
// or unset GEMINI_AUTH_TYPE defaults to api-key; anything outside the known set
// is a setup error. Exported so the runner can mirror it into the launcher's
// $GEMINI_AUTH_TYPE substitutions without duplicating the resolution.
export function geminiAuthType(): string {
  const raw = getEnv('GEMINI_AUTH_TYPE')?.trim();
  const authType = raw ? raw : GEMINI_AUTH_TYPE_API_KEY;
  if (!GEMINI_AUTH_TYPES.includes(authType)) {
    throw new ProvisionError(
      `GEMINI_AUTH_TYPE must be one of ${GEMINI_AUTH_TYPES.join(', ')}; got '${authType}'`,
    );
  }
  return authType;
}

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

// Build the stderr excerpt baked into a gemini link/list failure error (Python:
// _gemini_stderr_excerpt). Strip, replace any occurrence of GEMINI_API_KEY with
// '[redacted]' so a CLI that echoes the key into stderr cannot leak it into the
// error text (and thence verdict.json / logs), then truncate to 300 chars.
function geminiStderrExcerpt(stderr: string): string {
  const apiKey = getEnv('GEMINI_API_KEY') ?? '';
  let excerpt = stderr.trim();
  if (apiKey) {
    excerpt = excerpt.replaceAll(apiKey, '[redacted]');
  }
  return excerpt.slice(0, 300);
}

// Write `content` to `path` at mode 0600, creating parent dirs (Python:
// _write_private_text). writeFileSync's `mode` only applies on create, so chmod
// after to enforce 0600 even when the file already existed.
function writePrivateText(path: string, content: string): void {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, content, { mode: 0o600 });
  chmodSync(path, 0o600);
}

// Copy the Gemini OAuth credential files from GEMINI_OAUTH_HOME (default
// ~/.gemini) into the run's .gemini dir at 0600 (Python:
// _copy_gemini_oauth_credentials). A missing source file is a setup error.
function copyGeminiOauthCredentials(configDir: string): void {
  const sourceHome = getEnv('GEMINI_OAUTH_HOME') ?? join(homedir(), '.gemini');
  for (const name of GEMINI_OAUTH_CREDENTIAL_FILES) {
    const source = join(sourceHome, name);
    if (!statSync(source, { throwIfNoEntry: false })?.isFile()) {
      throw new ProvisionError(
        `Gemini OAuth credential file not found: ${source}`,
      );
    }
    writePrivateText(
      join(configDir, '.gemini', name),
      readFileSync(source, 'utf8'),
    );
  }
}

// Detect a `superpowers` row in `gemini extensions list` output (Python:
// _gemini_extension_list_shows_superpowers): a line whose first word is
// `superpowers` (case-insensitive) optionally followed by whitespace or `(`.
// A leading non-word glyph + space is tolerated so a decorated row like
// "✓ superpowers (5.1.0)" matches. Callers pass stdout+stderr merged because
// newer gemini prints the listing to stderr.
function extensionListShowsSuperpowers(output: string): boolean {
  for (const line of output.split('\n')) {
    if (/^\s*([^\w\s]+\s+)?superpowers(\s|\(|$)/i.test(line)) {
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

    // Resolve the auth type once (Python: _gemini_auth_type resolved in
    // _seed_gemini_config). A bogus value raises here, before any subprocess.
    const authType = geminiAuthType();

    // GEMINI_API_KEY seeds the secret env file, but only in api-key mode
    // (Python: _write_gemini_env_file guards on auth_type). In oauth mode the
    // key is absent by design.
    const apiKey = getEnv('GEMINI_API_KEY') ?? '';
    if (authType === GEMINI_AUTH_TYPE_API_KEY && !apiKey) {
      throw new ProvisionError(
        'GEMINI_API_KEY not set; cannot seed Gemini auth',
      );
    }

    mkdirSync(configDir, { recursive: true });

    // .gemini/settings.json: merge into any existing file and set
    // security.auth.selectedType to the resolved auth type (Python:
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
    auth['selectedType'] = authType;
    security['auth'] = auth;
    const merged: Record<string, unknown> = { ...settings, security };
    mkdirSync(join(configDir, '.gemini'), { recursive: true });
    writeFileSync(settingsPath, JSON.stringify(merged, null, 2));

    // .gemini-env carries GEMINI_API_KEY for the launcher in api-key mode;
    // oauth mode writes an empty file (still 0600) and copies the OAuth
    // credentials into .gemini instead (Python: _write_gemini_env_file +
    // _copy_gemini_oauth_credentials).
    const envFile = join(configDir, GEMINI_ENV_FILE_NAME);
    const envContent =
      authType === GEMINI_AUTH_TYPE_API_KEY
        ? `GEMINI_API_KEY=${shellSingleQuote(apiKey)}\n`
        : '';
    writeFileSync(envFile, envContent, { mode: 0o600 });
    chmodSync(envFile, 0o600);
    if (authType === GEMINI_AUTH_TYPE_OAUTH) {
      copyGeminiOauthCredentials(configDir);
    }

    // Env passed to the gemini subprocesses (Python: the `env` dict).
    const agentVars: Record<string, string> = {
      GEMINI_CLI_HOME: configDir,
      GEMINI_CLI_TRUST_WORKSPACE: 'true',
      GEMINI_DEFAULT_AUTH_TYPE: authType,
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
        `gemini extensions link failed (exit ${String(link.status)}); stderr: ${geminiStderrExcerpt(link.stderr)}`,
      );
    }

    // gemini extensions list — verify superpowers appears.
    const listing = runner.run('gemini', ['extensions', 'list'], {
      cwd: configDir,
      env: subprocessEnv,
    });
    if (listing.status !== 0) {
      throw new ProvisionError(
        `gemini extensions list failed (exit ${String(listing.status)}); stderr: ${geminiStderrExcerpt(listing.stderr)}`,
      );
    }
    if (
      !extensionListShowsSuperpowers(`${listing.stdout}\n${listing.stderr}`)
    ) {
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
