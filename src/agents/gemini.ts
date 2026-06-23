import {
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
import type { Credential } from '../contracts/credential.ts';
import { resolveApiKey } from '../credentials/resolve.ts';
import { envSnapshot, getEnv } from '../env.ts';
import type { CommandRunner } from './command-runner.ts';
import { type CodingAgent, ProvisionError, type RunHome } from './index.ts';
import { writePrivateFileNoFollow } from './private-file.ts';

// Gemini-family provisioning: install the Superpowers CLI extension into an
// isolated GEMINI_CLI_HOME without invoking the model. Writes
// .gemini/settings.json (auth selectedType) and a mode-0600 .gemini-env carrying
// GEMINI_API_KEY, then shells out to `gemini extensions link ... --consent` +
// `gemini extensions list` through the injected CommandRunner and verifies the
// install manifests landed.

// Name of the secret env file written into GEMINI_CLI_HOME. Shell-quoted like
// ClaudeAgent's .claude-env.
const GEMINI_ENV_FILE_NAME = '.gemini-env';

// Gemini auth-type values. api-key mode seeds GEMINI_API_KEY; oauth-personal
// copies the local OAuth credential files instead.
const GEMINI_AUTH_TYPE_API_KEY = 'gemini-api-key';
const GEMINI_AUTH_TYPE_OAUTH = 'oauth-personal';
const GEMINI_AUTH_TYPES: readonly string[] = [
  GEMINI_AUTH_TYPE_API_KEY,
  GEMINI_AUTH_TYPE_OAUTH,
];

// OAuth credential files the adapter copies from GEMINI_OAUTH_HOME.
const GEMINI_OAUTH_CREDENTIAL_FILES: readonly string[] = [
  'oauth_creds.json',
  'google_accounts.json',
];

// Resolve the requested Gemini auth type. An empty or unset GEMINI_AUTH_TYPE
// defaults to api-key; anything outside the known set is a setup error. Exported
// so the runner can mirror it into the launcher's $GEMINI_AUTH_TYPE
// substitutions without duplicating the resolution.
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

// Files that must exist under SUPERPOWERS_ROOT for the extension to install.
const GEMINI_REQUIRED_SUPERPOWERS_FILES: readonly string[] = [
  'gemini-extension.json',
  'GEMINI.md',
  'skills/using-superpowers/SKILL.md',
  'skills/using-superpowers/references/gemini-tools.md',
];

// Manifest files `gemini extensions link` writes on success. Missing any of
// these means the link silently no-op'd.
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

// Build the stderr excerpt baked into a gemini link/list failure error. Strip,
// replace any occurrence of the resolved api key with '[redacted]' so a CLI
// that echoes the key into stderr cannot leak it into the error text (and
// thence verdict.json / logs), then truncate to 300 chars.
function geminiStderrExcerpt(stderr: string, resolvedApiKey: string): string {
  let excerpt = stderr.trim();
  if (resolvedApiKey) {
    excerpt = excerpt.replaceAll(resolvedApiKey, '[redacted]');
  }
  return excerpt.slice(0, 300);
}

// Write `content` to `path` at mode 0600, creating parent dirs. The write goes
// through the shared O_NOFOLLOW writer so a pre-placed symlink at the destination
// cannot redirect the secret.
function writePrivateText(path: string, content: string): void {
  mkdirSync(join(path, '..'), { recursive: true });
  writePrivateFileNoFollow(path, content);
}

// Expand a leading ~ to HOME. Reads HOME only through env.ts.
function expanduser(p: string): string {
  if (p === '~' || p.startsWith('~/')) {
    const home = getEnv('HOME');
    if (home !== undefined && home !== '') {
      return p === '~' ? home : join(home, p.slice(2));
    }
  }
  return p;
}

// Verify the `gemini` binary resolves on PATH before provisioning. Use
// Bun.which against the sanctioned PATH snapshot — `command -v` would have to run
// through a shell, and the subprocess seam's spawnSync has none, so on Linux that
// probe ENOENTs and falsely reports the binary missing.
function requireGeminiBinaryOnPath(): void {
  if (Bun.which('gemini', { PATH: envSnapshot()['PATH'] ?? '' }) === null) {
    throw new ProvisionError(
      'gemini not found on PATH; cannot run Gemini evals',
    );
  }
}

// Copy the Gemini OAuth credential files from GEMINI_OAUTH_HOME (default
// ~/.gemini) into the run's .gemini dir at 0600. A missing source file is a
// setup error.
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

// Detect a `superpowers` row in `gemini extensions list` output: a line whose
// first word is `superpowers` (case-insensitive) optionally followed by
// whitespace or `(`.
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
// should exist after pure provisioning. Returns the GEMINI_CLI_HOME-relative
// paths found.
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

  provision(
    home: RunHome,
    runner: CommandRunner,
    credential?: Credential,
  ): Record<string, string> {
    const { configDir } = home;

    // SUPERPOWERS_ROOT must be set and carry the required extension files. The
    // raw value is expanduser()'d before every filesystem touch.
    const superpowersRaw = getEnv('SUPERPOWERS_ROOT') ?? '';
    if (!superpowersRaw) {
      throw new ProvisionError(
        'SUPERPOWERS_ROOT not set; cannot install Gemini Superpowers extension',
      );
    }
    const superpowersRoot = expanduser(superpowersRaw);
    const missingRoot = GEMINI_REQUIRED_SUPERPOWERS_FILES.filter(
      (rel) => !existsSync(join(superpowersRoot, rel)),
    );
    if (missingRoot.length > 0) {
      throw new ProvisionError(
        `SUPERPOWERS_ROOT is missing required Gemini Superpowers files: ${missingRoot.join(', ')}`,
      );
    }

    // Fail fast if the gemini CLI is not on PATH, right after the
    // SUPERPOWERS_ROOT validation. Without this a missing binary surfaces later
    // as a confusing 'gemini extensions link failed (exit null)'.
    requireGeminiBinaryOnPath();

    // Resolve the auth type once. A bogus value raises here, before any
    // subprocess.
    const authType = geminiAuthType();

    // GEMINI_API_KEY seeds the secret env file, but only in api-key mode. In
    // oauth mode the key is absent by design. When a credential is present,
    // resolve the key via the credential (honoring api_key_env override);
    // otherwise fall back to the conventional GEMINI_API_KEY env var.
    let apiKey = '';
    if (authType === GEMINI_AUTH_TYPE_API_KEY) {
      if (credential !== undefined && credential.auth === 'api-key') {
        try {
          const resolution = resolveApiKey(credential, 'GEMINI_API_KEY');
          if (resolution.kind !== 'env') {
            throw new ProvisionError(
              'gemini: could not resolve api key from credential',
            );
          }
          apiKey = resolution.value;
        } catch (e) {
          throw e instanceof ProvisionError
            ? e
            : new ProvisionError(e instanceof Error ? e.message : String(e));
        }
      } else {
        apiKey = getEnv('GEMINI_API_KEY') ?? '';
        if (!apiKey) {
          throw new ProvisionError(
            'GEMINI_API_KEY not set; cannot seed Gemini auth',
          );
        }
      }
    }

    mkdirSync(configDir, { recursive: true });

    // .gemini/settings.json: merge into any existing file and set
    // security.auth.selectedType to the resolved auth type. JSON.stringify with
    // indent 2, no trailing newline.
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
    // credentials into .gemini instead.
    const envFile = join(configDir, GEMINI_ENV_FILE_NAME);
    const envContent =
      authType === GEMINI_AUTH_TYPE_API_KEY
        ? `GEMINI_API_KEY=${shellSingleQuote(apiKey)}\n`
        : '';
    writePrivateFileNoFollow(envFile, envContent);
    if (authType === GEMINI_AUTH_TYPE_OAUTH) {
      copyGeminiOauthCredentials(configDir);
    }

    // Trust/auth vars the launcher needs (returned to the runner). These are
    // genuine gemini-read knobs, not the config-dir token.
    const agentVars: Record<string, string> = {
      GEMINI_CLI_TRUST_WORKSPACE: 'true',
      GEMINI_DEFAULT_AUTH_TYPE: authType,
    };
    // The provisioning subprocesses additionally need GEMINI_CLI_HOME pointed at
    // the isolated config dir so the link/list run against it. The launched agent
    // finds its config via the throwaway $HOME default, so GEMINI_CLI_HOME is
    // NOT returned — it is preflight-only.
    const subprocessEnv = {
      ...envSnapshot(),
      ...agentVars,
      GEMINI_CLI_HOME: configDir,
    };

    // gemini extensions link <SUPERPOWERS_ROOT> --consent
    const link = runner.run(
      'gemini',
      ['extensions', 'link', superpowersRoot, '--consent'],
      { cwd: configDir, env: subprocessEnv },
    );
    if (link.status !== 0) {
      throw new ProvisionError(
        `gemini extensions link failed (exit ${String(link.status)}); stderr: ${geminiStderrExcerpt(link.stderr, apiKey)}`,
      );
    }

    // gemini extensions list — verify superpowers appears.
    const listing = runner.run('gemini', ['extensions', 'list'], {
      cwd: configDir,
      env: subprocessEnv,
    });
    if (listing.status !== 0) {
      throw new ProvisionError(
        `gemini extensions list failed (exit ${String(listing.status)}); stderr: ${geminiStderrExcerpt(listing.stderr, apiKey)}`,
      );
    }
    if (
      !extensionListShowsSuperpowers(`${listing.stdout}\n${listing.stderr}`)
    ) {
      throw new ProvisionError(
        'gemini extensions list did not show Superpowers extension',
      );
    }

    // The link must have written its install manifests.
    const missingManifests = GEMINI_EXTENSION_MANIFESTS.filter(
      (rel) => !existsSync(join(configDir, rel)),
    );
    if (missingManifests.length > 0) {
      throw new ProvisionError(
        `gemini extension link completed but expected metadata files are missing: ${missingManifests.join(', ')}`,
      );
    }

    // Provisioning must not have run the model.
    const transcripts = geminiTranscripts(configDir);
    if (transcripts.length > 0) {
      throw new ProvisionError(
        `gemini provisioning unexpectedly wrote transcripts before capture snapshot: ${transcripts.join(', ')}`,
      );
    }

    return { ...agentVars };
  }
}
