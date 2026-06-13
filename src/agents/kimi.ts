import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { z } from 'zod';
import type { AgentConfig } from '../contracts/agent-config.ts';
import { envSnapshot, getEnv } from '../env.ts';
import type { CommandRunner } from './command-runner.ts';
import { type CodingAgent, ProvisionError, type RunHome } from './index.ts';

// Kimi-family provisioning (mirrors quorum/runner.py:_seed_kimi_config, which
// orchestrates quorum/kimi.py). The heaviest adapter: it (1) resolves the kimi
// binary on PATH, (2) computes the effective model env from host overrides,
// (3) proves the model can authenticate via a one-shot stream-json preflight
// (or validates a precomputed sentinel), (4) installs the local Superpowers
// checkout as the sole enabled Kimi plugin, (5) builds the isolated subprocess
// env, writes it to a mode-0600 runtime env file, and writes a redacted config
// summary. provision() is SETUP ONLY; the runtime/post-run items are deferred
// to B3 as NOTEs below.
//
// The single subprocess interaction is the live auth preflight, driven through
// the injected CommandRunner so the hermetic gate stubs it. Everything else is
// deterministic file generation the gate asserts directly.

// Host KIMI_MODEL_* keys we accept as overrides; any other KIMI_MODEL_* is a
// hard error (mirrors ALLOWED_HOST_KIMI_MODEL_ENV).
const ALLOWED_HOST_KIMI_MODEL_ENV: ReadonlySet<string> = new Set([
  'KIMI_MODEL_API_KEY',
  'KIMI_MODEL_NAME',
]);

// The model-provider defaults quorum bakes in (mirrors DEFAULT_KIMI_MODEL_ENV).
const DEFAULT_KIMI_MODEL_ENV: Readonly<Record<string, string>> = {
  KIMI_MODEL_NAME: 'kimi-for-coding',
  KIMI_MODEL_PROVIDER_TYPE: 'kimi',
  KIMI_MODEL_BASE_URL: 'https://api.kimi.com/coding/v1',
  KIMI_MODEL_MAX_CONTEXT_SIZE: '262144',
  KIMI_MODEL_CAPABILITIES: 'thinking,image_in,video_in,tool_use',
  KIMI_MODEL_DEFAULT_THINKING: 'true',
};

// Telemetry/cron/keep-alive opt-outs forced for every run (mirrors
// KIMI_RUNTIME_FLAGS).
const KIMI_RUNTIME_FLAGS: Readonly<Record<string, string>> = {
  KIMI_DISABLE_TELEMETRY: '1',
  KIMI_DISABLE_CRON: '1',
  KIMI_CODE_BACKGROUND_KEEP_ALIVE_ON_EXIT: 'false',
};

// Keys surfaced (with the API key redacted) in effective-kimi-model-config.json
// (mirrors KIMI_CONFIG_SUMMARY_ENV: DEFAULT_KIMI_MODEL_ENV | KIMI_RUNTIME_FLAGS |
// {KIMI_MODEL_API_KEY}).
const KIMI_CONFIG_SUMMARY_ENV: ReadonlySet<string> = new Set<string>([
  ...Object.keys(DEFAULT_KIMI_MODEL_ENV),
  ...Object.keys(KIMI_RUNTIME_FLAGS),
  'KIMI_MODEL_API_KEY',
]);

// Name of the secret runtime env file the launcher sources (mirrors the
// kimi-runtime.env basename in write_kimi_runtime_env_file).
const KIMI_RUNTIME_ENV_FILE_NAME = 'kimi-runtime.env';

// The minimal Superpowers Kimi plugin manifest surface validate_superpowers_kimi_root
// asserts. Everything else passes through (the manifest can evolve).
const KimiManifestSchema = z
  .object({
    name: z.string().optional(),
    skills: z.string().optional(),
    sessionStart: z
      .object({ skill: z.string().optional() })
      .passthrough()
      .optional(),
    skillInstructions: z.unknown().optional(),
  })
  .passthrough();

// The precomputed-preflight sentinel surface (a JSON object of string|number).
const SentinelSchema = z.record(z.union([z.string(), z.number()]));

export class KimiAgent implements CodingAgent {
  readonly config: AgentConfig;

  // erasableSyntaxOnly forbids `constructor(readonly config)`; assign in body.
  constructor(config: AgentConfig) {
    this.config = config;
  }

  provision(home: RunHome, runner: CommandRunner): Record<string, string> {
    const { configDir } = home;

    // _seed_kimi_config requires SUPERPOWERS_ROOT up front (RunnerError ->
    // ProvisionError). Read env only through env.ts.
    const superpowersRoot = getEnv('SUPERPOWERS_ROOT');
    if (superpowersRoot === undefined || superpowersRoot === '') {
      throw new ProvisionError(
        'SUPERPOWERS_ROOT not set; cannot install Kimi Superpowers plugin',
      );
    }
    const preflightSentinel = getEnv('QUORUM_KIMI_PREFLIGHT_SENTINEL');
    const preflightToken = getEnv('QUORUM_KIMI_PREFLIGHT_TOKEN');

    // 1. resolve_kimi_binary: PATH lookup (KimiConfigError -> ProvisionError).
    const kimiBinary = resolveKimiBinary(this.config.binary, runner);

    // 2. effective_kimi_model_env: merge defaults with host overrides.
    const kimiModelEnv = effectiveKimiModelEnv();

    // 3. Preflight: validate the precomputed sentinel when present, else run
    //    the LIVE one-shot auth preflight through the runner.
    if (preflightSentinel !== undefined && preflightSentinel !== '') {
      validateKimiPreflightSentinel(preflightSentinel, {
        kimiBinary,
        kimiModelEnv,
        preflightToken,
      });
    } else {
      runKimiAuthPreflight(runner, {
        kimiBinary,
        kimiModelEnv,
      });
    }

    // 4. install_kimi_superpowers_plugin: validate the local checkout, then
    //    register it as the only enabled plugin (plugins/installed.json).
    installKimiSuperpowersPlugin(configDir, superpowersRoot);

    // Create the isolated kimi home subdirs the Python seeds. The kimi home IS
    // configDir (agent_config_env = KIMI_CODE_HOME = home.configDir).
    mkdirSync(configDir, { recursive: true });
    for (const child of [
      'home',
      'cache',
      'xdg-config',
      'xdg-cache',
      'xdg-data',
    ]) {
      mkdirSync(join(configDir, child), { recursive: true });
    }

    // 5. build_kimi_subprocess_env: the launcher's full runtime env (cwd is the
    //    kimi home itself, mirroring _seed_kimi_config's cwd=kimi_home).
    const runtimeEnv = buildKimiSubprocessEnv({
      kimiHome: configDir,
      kimiModelEnv,
    });

    // write_kimi_runtime_env_file: mode-0600 secret file of sorted shell
    // assignments. NOTE: the Python places this file OUTSIDE the run artifact
    // root (write_kimi_runtime_env_file -> _kimi_runtime_env_temp_parent mkdtemp
    // keyed on run_dir.name, with cleanup_dirs teardown) so capture never
    // snapshots the secret. RunHome carries no run_dir, so we write it under an
    // OS-temp dir (still outside configDir/workdir) and return its path; the
    // integrator can relocate to a run-scoped temp parent if it threads run_dir.
    const envFilePath = writeKimiRuntimeEnvFile(runtimeEnv);

    // write_effective_kimi_config: redacted summary (KIMI_MODEL_API_KEY ->
    // "<present>"). Written into the kimi home (configDir).
    writeEffectiveKimiConfig(configDir, runtimeEnv, kimiBinary);

    // The env map the launcher needs: KIMI_CODE_HOME (agent_config_env), plus the
    // runtime env-file path and resolved binary (the Python returns these as the
    // $KIMI_ENV_FILE / $KIMI_BINARY launch-agent substitutions; the launcher
    // sources $KIMI_ENV_FILE and execs $KIMI_BINARY).
    return {
      [this.config.agent_config_env]: configDir,
      KIMI_ENV_FILE: envFilePath,
      KIMI_BINARY: kimiBinary,
    };

    // NOTE (DEFER to B3, capture/post-run; do NOT implement here):
    // - run_kimi_auth_preflight's session_index.jsonl workDir attribution +
    //   sessionDir/wire.jsonl verification: the synchronous one-shot
    //   CommandRunner cannot observe the on-disk session_index the live kimi
    //   process writes, so the workdir-attribution leg of the preflight is a
    //   B3 capture concern (streamingRisk: the live preflight is a one-shot
    //   subprocess here — same single-run modeling/caveat as the codex
    //   app-server step).
    // - kimi_logs_have_superpowers_session_start: a capture-time assertion over
    //   sessions/**/wire.jsonl that the Superpowers session-start injection fired.
    // - cleanup_dirs teardown tracking (the env-file parent temp dir) belongs to
    //   the runner's AgentRuntime cleanup, not provision().
  }
}

// resolve_kimi_binary: PATH lookup. node has no shutil.which; probe via the
// runner (`command -v <binary>`) so the hermetic gate can stub the lookup, and
// raise ProvisionError (mapping KimiConfigError) when it is missing.
function resolveKimiBinary(binary: string, runner: CommandRunner): string {
  const probe = runner.run('command', ['-v', binary], {
    env: { ...envSnapshot() },
  });
  const resolved = probe.stdout.trim();
  if (probe.status !== 0 || resolved === '') {
    throw new ProvisionError(
      `'${binary}' not found on PATH; cannot run Kimi evals`,
    );
  }
  return resolved;
}

// effective_kimi_model_env: reject unsupported host KIMI_MODEL_* overrides,
// require KIMI_MODEL_API_KEY, merge defaults + runtime flags, then overlay the
// host api key and optional model-name override. Reads env only through env.ts.
function effectiveKimiModelEnv(): Record<string, string> {
  const source = envSnapshot();
  const unknown: string[] = [];
  for (const key of Object.keys(source)) {
    if (
      key.startsWith('KIMI_MODEL_') &&
      !ALLOWED_HOST_KIMI_MODEL_ENV.has(key)
    ) {
      unknown.push(key);
    }
  }
  if (unknown.length > 0) {
    unknown.sort();
    throw new ProvisionError(
      `unsupported host KIMI_MODEL_* override(s): ${unknown.join(', ')}`,
    );
  }
  const apiKey = getEnv('KIMI_MODEL_API_KEY');
  if (apiKey === undefined || apiKey === '') {
    throw new ProvisionError('KIMI_MODEL_API_KEY is required for Kimi evals');
  }
  const merged: Record<string, string> = {
    ...DEFAULT_KIMI_MODEL_ENV,
    ...KIMI_RUNTIME_FLAGS,
  };
  merged['KIMI_MODEL_API_KEY'] = apiKey;
  const modelName = getEnv('KIMI_MODEL_NAME');
  if (modelName !== undefined && modelName !== '') {
    merged['KIMI_MODEL_NAME'] = modelName;
  }
  return merged;
}

interface PreflightContext {
  readonly kimiBinary: string;
  readonly kimiModelEnv: Readonly<Record<string, string>>;
}

// kimi_preflight_sentinel_payload: the canonical object a precomputed sentinel
// must match, including the SHA256 of the preflight token.
function kimiPreflightSentinelPayload(
  ctx: PreflightContext,
  preflightToken: string,
): Record<string, string | number> {
  const env = ctx.kimiModelEnv;
  return {
    schema: 1,
    agent: 'kimi',
    kimi_binary: ctx.kimiBinary,
    model: env['KIMI_MODEL_NAME'] ?? '',
    provider: env['KIMI_MODEL_PROVIDER_TYPE'] ?? '',
    base_url: env['KIMI_MODEL_BASE_URL'] ?? '',
    preflight_token_sha256: createHash('sha256')
      .update(preflightToken)
      .digest('hex'),
  };
}

// validate_kimi_preflight_sentinel: parse the sentinel file and require every
// expected key to match (ProvisionError mapping KimiConfigError otherwise).
function validateKimiPreflightSentinel(
  sentinelPath: string,
  ctx: PreflightContext & { readonly preflightToken: string | undefined },
): void {
  if (!existsSync(sentinelPath)) {
    throw new ProvisionError(
      `Kimi preflight sentinel missing: ${sentinelPath}`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(sentinelPath, 'utf8'));
  } catch (e) {
    throw new ProvisionError(
      `Kimi preflight sentinel is not valid JSON: ${String(e)}`,
    );
  }
  const sentinel = SentinelSchema.safeParse(parsed);
  if (!sentinel.success) {
    throw new ProvisionError('Kimi preflight sentinel must be a JSON object');
  }
  const token = ctx.preflightToken;
  if (token === undefined || token.trim() === '') {
    throw new ProvisionError(
      'Kimi preflight sentinel token missing or malformed',
    );
  }
  const expected = kimiPreflightSentinelPayload(ctx, token);
  const payload = sentinel.data;
  for (const key of Object.keys(expected)) {
    if (payload[key] !== expected[key]) {
      throw new ProvisionError(
        `Kimi preflight sentinel ${key} mismatch: expected ${JSON.stringify(expected[key])}, got ${JSON.stringify(payload[key])}`,
      );
    }
  }
}

// run_kimi_auth_preflight: drive the LIVE one-shot auth probe through the runner
// seam. The Python runs `kimi -p "Reply with EXACTLY OK." --output-format=
// stream-json` in a throwaway home and then verifies session_index workdir
// attribution; the synchronous one-shot CommandRunner can model only the
// subprocess + stdout scan (kimi_stream_json_reply_ok). The session_index /
// wire.jsonl verification is deferred to B3 (see the NOTE in provision()).
function runKimiAuthPreflight(
  runner: CommandRunner,
  ctx: PreflightContext,
): void {
  const env = buildKimiSubprocessEnv({
    kimiHome: join(tmpdir(), 'quorum-kimi-preflight'),
    kimiModelEnv: ctx.kimiModelEnv,
  });
  const result = runner.run(
    ctx.kimiBinary,
    ['-p', 'Reply with EXACTLY OK.', '--output-format=stream-json'],
    { env },
  );
  if (result.status !== 0) {
    const stderr = result.stderr.trim().slice(0, 300);
    throw new ProvisionError(
      `kimi auth preflight failed (exit ${result.status}); stderr: ${stderr}`,
    );
  }
  if (!kimiStreamJsonReplyOk(result.stdout)) {
    throw new ProvisionError(
      `kimi auth preflight did not return OK; stdout: ${result.stdout.trim().slice(0, 300)}`,
    );
  }
}

// _normalized_ok: strip trailing punctuation/whitespace, uppercase, compare OK.
function normalizedOk(text: string): boolean {
  return (
    text
      .trim()
      .replace(/[.!]+$/, '')
      .trim()
      .toUpperCase() === 'OK'
  );
}

interface StreamJsonRow {
  readonly role?: unknown;
  readonly type?: unknown;
  readonly content?: unknown;
}

// kimi_stream_json_reply_ok: concatenate assistant content across the
// stream-json rows and test for a normalized OK. A row counts as assistant when
// role === 'assistant', or (role absent) when type is one of assistant/message/
// response. content is a string or a list of {text} parts.
function kimiStreamJsonReplyOk(stdout: string): boolean {
  const assistantParts: string[] = [];
  for (const line of stdout.split('\n')) {
    if (line.trim() === '') continue;
    let row: unknown;
    try {
      row = JSON.parse(line);
    } catch {
      continue;
    }
    if (!isRecord(row)) continue;
    const typed = row as StreamJsonRow;
    let isAssistant: boolean;
    if (typed.role !== undefined && typed.role !== null) {
      isAssistant = typed.role === 'assistant';
    } else {
      isAssistant =
        typed.type === 'assistant' ||
        typed.type === 'message' ||
        typed.type === 'response';
    }
    if (!isAssistant) continue;
    const content = typed.content;
    if (typeof content === 'string') {
      assistantParts.push(content);
    } else if (Array.isArray(content)) {
      for (const part of content) {
        if (isRecord(part)) {
          const text = part['text'];
          if (typeof text === 'string') {
            assistantParts.push(text);
          }
        }
      }
    }
  }
  return normalizedOk(assistantParts.join(''));
}

interface SubprocessEnvContext {
  readonly kimiHome: string;
  readonly kimiModelEnv: Readonly<Record<string, string>>;
}

// build_kimi_subprocess_env: an allow-listed, hermetic env for the kimi process.
// Pass through PATH/TERM/LANG/SHELL plus LC_* and *_proxy from the host, overlay
// the model env, then set HOME + the KIMI/XDG dirs under the kimi home.
function buildKimiSubprocessEnv(
  ctx: SubprocessEnvContext,
): Record<string, string> {
  const base = envSnapshot();
  const allowExact: ReadonlySet<string> = new Set([
    'PATH',
    'TERM',
    'LANG',
    'SHELL',
  ]);
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(base)) {
    if (value !== undefined && allowExact.has(key)) {
      out[key] = value;
    }
  }
  for (const [key, value] of Object.entries(base)) {
    if (
      value !== undefined &&
      (key.startsWith('LC_') || key.toLowerCase().endsWith('_proxy'))
    ) {
      out[key] = value;
    }
  }
  for (const [key, value] of Object.entries(ctx.kimiModelEnv)) {
    out[key] = value;
  }
  out['HOME'] = join(ctx.kimiHome, 'home');
  out['KIMI_CODE_HOME'] = ctx.kimiHome;
  out['KIMI_CODE_CACHE_DIR'] = join(ctx.kimiHome, 'cache');
  out['XDG_CONFIG_HOME'] = join(ctx.kimiHome, 'xdg-config');
  out['XDG_CACHE_HOME'] = join(ctx.kimiHome, 'xdg-cache');
  out['XDG_DATA_HOME'] = join(ctx.kimiHome, 'xdg-data');
  return out;
}

// validate_superpowers_kimi_root + install_kimi_superpowers_plugin: assert the
// local checkout carries the Kimi plugin manifest + the two seed skills with the
// expected manifest fields, then write plugins/installed.json registering the
// checkout as the sole enabled plugin.
function installKimiSuperpowersPlugin(
  kimiHome: string,
  superpowersRoot: string,
): void {
  const root = validateSuperpowersKimiRoot(superpowersRoot);
  const pluginsDir = join(kimiHome, 'plugins');
  mkdirSync(pluginsDir, { recursive: true });
  const now = isoMillisZulu();
  const payload = {
    version: 1,
    plugins: [
      {
        id: 'superpowers',
        root,
        source: 'local-path',
        enabled: true,
        installedAt: now,
        updatedAt: now,
        originalSource: root,
      },
    ],
  };
  writeFileSync(
    join(pluginsDir, 'installed.json'),
    `${JSON.stringify(payload, null, 2)}\n`,
  );
}

// validate_superpowers_kimi_root: resolve the checkout, require the manifest +
// seed skills, and assert the manifest's name/skills/sessionStart.skill/
// skillInstructions. Returns the resolved absolute root.
function validateSuperpowersKimiRoot(rootArg: string): string {
  const resolved = resolve(expanduser(rootArg));
  const manifestPath = join(resolved, '.kimi-plugin', 'plugin.json');
  const required: readonly string[] = [
    manifestPath,
    join(resolved, 'skills', 'using-superpowers', 'SKILL.md'),
    join(resolved, 'skills', 'brainstorming', 'SKILL.md'),
  ];
  const missing = required
    .filter((path) => !existsSync(path))
    .map((path) => relativeTo(resolved, path));
  if (missing.length > 0) {
    throw new ProvisionError(
      `SUPERPOWERS_ROOT missing Kimi files: ${missing.join(', ')}`,
    );
  }
  let manifest: z.infer<typeof KimiManifestSchema>;
  try {
    manifest = KimiManifestSchema.parse(
      JSON.parse(readFileSync(manifestPath, 'utf8')),
    );
  } catch (e) {
    throw new ProvisionError(`${manifestPath} is not valid JSON: ${String(e)}`);
  }
  if (manifest.name !== 'superpowers') {
    throw new ProvisionError('Kimi manifest name must be superpowers');
  }
  if (manifest.skills !== './skills/') {
    throw new ProvisionError('Kimi manifest skills must be ./skills/');
  }
  if (manifest.sessionStart?.skill !== 'using-superpowers') {
    throw new ProvisionError(
      'Kimi manifest sessionStart.skill must be using-superpowers',
    );
  }
  const instructions = manifest.skillInstructions;
  if (
    instructions === undefined ||
    instructions === null ||
    instructions === '' ||
    instructions === false ||
    (Array.isArray(instructions) && instructions.length === 0)
  ) {
    throw new ProvisionError(
      'Kimi manifest skillInstructions must be non-empty',
    );
  }
  return resolved;
}

// write_kimi_runtime_env_file: mode-0600 file of sorted `KEY='value'` shell
// assignments. See the provision() NOTE on why this lands under an OS-temp dir
// here rather than a run-scoped temp parent.
function writeKimiRuntimeEnvFile(
  env: Readonly<Record<string, string>>,
): string {
  const secretDir = mkdtempSync(join(tmpdir(), 'quorum-kimi-env-'));
  const path = join(secretDir, KIMI_RUNTIME_ENV_FILE_NAME);
  const keys = Object.keys(env).sort();
  const body = keys
    .map((key) => `${key}=${shellSingleQuote(env[key] ?? '')}\n`)
    .join('');
  writeFileSync(path, body, { mode: 0o600 });
  return path;
}

// write_effective_kimi_config: a redacted summary the gate can diff. Only the
// KIMI_CONFIG_SUMMARY_ENV keys, sorted, with KIMI_MODEL_API_KEY -> "<present>".
// kimi_version is null here (the Python passes None at this call site).
function writeEffectiveKimiConfig(
  kimiHome: string,
  env: Readonly<Record<string, string>>,
  kimiBinary: string,
): void {
  const modelEnv: Record<string, string> = {};
  for (const key of Object.keys(env).sort()) {
    if (KIMI_CONFIG_SUMMARY_ENV.has(key)) {
      modelEnv[key] =
        key === 'KIMI_MODEL_API_KEY' ? '<present>' : (env[key] ?? '');
    }
  }
  const payload = {
    kimi_binary: kimiBinary,
    kimi_version: null,
    model_env: modelEnv,
  };
  mkdirSync(kimiHome, { recursive: true });
  writeFileSync(
    join(kimiHome, 'effective-kimi-model-config.json'),
    `${JSON.stringify(payload, null, 2)}\n`,
  );
}

// Single-quote a value for a POSIX shell, escaping embedded single quotes
// (mirrors shlex.quote for the common case; matches ClaudeAgent/GeminiAgent).
function shellSingleQuote(s: string): string {
  return `'${s.replaceAll("'", `'\\''`)}'`;
}

// datetime.now(UTC).isoformat(timespec='milliseconds') with +00:00 -> Z.
function isoMillisZulu(): string {
  // toISOString yields e.g. 2026-06-12T00:00:00.000Z (millisecond precision).
  return new Date().toISOString();
}

// Expand a leading ~ to HOME (mirrors Path.expanduser for the common case).
function expanduser(p: string): string {
  if (p === '~' || p.startsWith('~/')) {
    const home = getEnv('HOME');
    if (home !== undefined && home !== '') {
      return p === '~' ? home : join(home, p.slice(2));
    }
  }
  return p;
}

// Path relative to a base for the missing-files diagnostic (mirrors
// Path.relative_to in validate_superpowers_kimi_root's error message).
function relativeTo(base: string, path: string): string {
  const prefix = base.endsWith('/') ? base : `${base}/`;
  return path.startsWith(prefix) ? path.slice(prefix.length) : path;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
