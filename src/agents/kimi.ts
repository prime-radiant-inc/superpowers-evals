import { createHash } from 'node:crypto';
import {
  type Dirent,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve, sep } from 'node:path';
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

// Substrings (uppercased) that mark an env var name as sensitive, and the
// minimum value length worth redacting (mirrors _SENSITIVE_ENV_NAME_PARTS /
// _MIN_SENSITIVE_VALUE_LEN). sanitizeKimiDiagnostic uses these to scrub secret
// values out of provisioning/preflight error diagnostics before they reach a
// verdict or log.
const SENSITIVE_ENV_NAME_PARTS: readonly string[] = [
  'KEY',
  'TOKEN',
  'SECRET',
  'PASSWORD',
];
const MIN_SENSITIVE_VALUE_LEN = 6;

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
    // SECURITY (H2): the whole provisioning motion — binary resolve, preflight,
    // plugin install, and the env-file/config writes — can surface diagnostics
    // that echo secrets (e.g. the API key in a failing preflight's stderr). Mirror
    // quorum/runner.py:_seed_kimi_config, which wraps the seed in
    // `except KimiConfigError as e: raise RunnerError(sanitize_kimi_diagnostic(e))`,
    // so NO raw secret-bearing text escapes provision() into the runner's catch
    // and verdict.json. Any ProvisionError we already raise is re-wrapped through
    // the same scrub (idempotent: a value already redacted has nothing left to
    // match).
    try {
      return this.seedKimiConfig(home, runner);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      throw new ProvisionError(sanitizeKimiDiagnostic(message));
    }
  }

  private seedKimiConfig(
    home: RunHome,
    runner: CommandRunner,
  ): Record<string, string> {
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
    const kimiBinary = resolveKimiBinary(this.config.binary);

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
    // assignments, placed OUTSIDE the run artifact root (via
    // _kimi_runtime_env_temp_parent + a run-scoped mkdtemp keyed on run_dir.name)
    // so capture never snapshots the secret. RunHome carries no explicit run_dir,
    // but the per-run dir IS configDir's parent (runner.py builds configDir =
    // run_dir/coding-agent-config), so we derive run_dir from configDir and the
    // escape guard keeps the secret out of the artifact root.
    const runDir = dirname(configDir);
    const envFilePath = writeKimiRuntimeEnvFile(runtimeEnv, { runDir });

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

    // NOTE (DEFER to capture/post-run / Wave-2b; do NOT implement here):
    // - kimi_logs_have_superpowers_session_start: a capture-time assertion over
    //   sessions/**/wire.jsonl that the Superpowers session-start injection fired
    //   during the REAL eval run (not the preflight). This reads the run's own
    //   session logs, which provision() never sees, so it belongs to the capture
    //   stage.
    // - cleanup_dirs teardown tracking (the env-file parent temp dir) belongs to
    //   the runner's AgentRuntime cleanup, not provision().
  }
}

// sanitize_kimi_diagnostic (SECURITY): scrub secret values out of a diagnostic
// message before it reaches a RunnerError / verdict / log. Redacts the
// KIMI_MODEL_API_KEY value plus any env value >=6 chars whose name (uppercased)
// contains KEY/TOKEN/SECRET/PASSWORD. Redaction runs longest-value-first so a
// shorter secret that is a substring of a longer one cannot survive as a tail.
//
// The runner is expected to wrap the whole kimi provisioning/preflight motion in
// this (parity with quorum/runner.py:688 and run_all.py:627); exported so
// Wave-2b can wire it at those call sites.
export function sanitizeKimiDiagnostic(
  message: unknown,
  env: Readonly<Record<string, string | undefined>> = envSnapshot(),
): string {
  let text = String(message);
  const values = new Set<string>();
  const apiKey = env['KIMI_MODEL_API_KEY'];
  if (apiKey) {
    values.add(apiKey);
  }
  for (const [key, value] of Object.entries(env)) {
    if (
      value &&
      value.length >= MIN_SENSITIVE_VALUE_LEN &&
      SENSITIVE_ENV_NAME_PARTS.some((part) => key.toUpperCase().includes(part))
    ) {
      values.add(value);
    }
  }
  const ordered = [...values].sort((a, b) => b.length - a.length);
  for (const value of ordered) {
    text = text.split(value).join('<redacted>');
  }
  return text;
}

// resolve_kimi_binary: PATH lookup. Mirrors the Python's shutil.which — a pure
// in-process PATH walk via Bun.which (matching antigravity's Bun.which('agy') and
// the claude preflight in runner/index.ts). A `command -v` subprocess probe would
// ENOENT on Linux because `command` is a shell builtin, not an executable, and the
// default CommandRunner spawns with no shell. Raise ProvisionError (mapping
// KimiConfigError) when the binary is missing.
function resolveKimiBinary(binary: string): string {
  const resolved = Bun.which(binary, { PATH: envSnapshot()['PATH'] ?? '' });
  if (resolved === null || resolved === '') {
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
// stream-json` in a throwaway home (with cwd set), checks the stream-json reply,
// then PROVES home isolation took effect by reading the on-disk session_index:
// a row whose realpath(workDir) == the preflight cwd, whose sessionDir resolves
// under <kimiHome>/sessions, and whose sessionDir contains a **/wire.jsonl.
// Mirrors quorum/kimi.py:run_kimi_auth_preflight (306-342). The CommandRunner
// runs the subprocess; the file verification reads what that process wrote.
function runKimiAuthPreflight(
  runner: CommandRunner,
  ctx: PreflightContext,
): void {
  const tmpRoot = mkdtempSync(join(tmpdir(), 'quorum-kimi-preflight-'));
  try {
    const kimiHome = join(tmpRoot, 'kimi-home');
    const cwd = join(tmpRoot, 'cwd');
    mkdirSync(cwd, { recursive: true });
    const env = buildKimiSubprocessEnv({
      kimiHome,
      kimiModelEnv: ctx.kimiModelEnv,
    });
    const result = runner.run(
      ctx.kimiBinary,
      ['-p', 'Reply with EXACTLY OK.', '--output-format=stream-json'],
      { cwd, env },
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
    verifyKimiPreflightSession(kimiHome, cwd);
  } finally {
    rmSync(tmpRoot, { recursive: true, force: true });
  }
}

// The session-attribution leg of run_kimi_auth_preflight: read session_index.jsonl
// and prove the live kimi process ran inside the isolated home — a row whose
// realpath(workDir) == the preflight cwd, whose sessionDir resolves under
// <kimiHome>/sessions, and whose sessionDir holds a **/wire.jsonl.
function verifyKimiPreflightSession(kimiHome: string, cwd: string): void {
  const indexPath = join(kimiHome, 'session_index.jsonl');
  if (!existsSync(indexPath) || !statSync(indexPath).isFile()) {
    throw new ProvisionError(
      'kimi auth preflight produced no session_index.jsonl',
    );
  }
  const target = realpathSync(cwd);
  const sessionsRoot = resolveMaybe(join(kimiHome, 'sessions'));
  let matchedWorkdir = false;
  let outsideSessionDir = false;
  const matchingSessionDirs: string[] = [];
  for (const line of readFileSync(indexPath, 'utf8').split('\n')) {
    if (line.trim() === '') continue;
    let row: unknown;
    try {
      row = JSON.parse(line);
    } catch {
      continue;
    }
    if (!isRecord(row)) continue;
    const workDir = row['workDir'];
    if (typeof workDir !== 'string') continue;
    if (resolveMaybe(workDir) !== target) continue;
    matchedWorkdir = true;
    const sessionDir = row['sessionDir'];
    if (typeof sessionDir !== 'string' || sessionDir === '') continue;
    const resolvedSessionDir = resolveMaybe(sessionDir);
    if (!isInsideOrEqual(resolvedSessionDir, sessionsRoot)) {
      outsideSessionDir = true;
      continue;
    }
    matchingSessionDirs.push(resolvedSessionDir);
  }
  if (!matchedWorkdir) {
    throw new ProvisionError(
      'kimi auth preflight session_index workDir did not match cwd',
    );
  }
  if (matchingSessionDirs.length === 0) {
    if (outsideSessionDir) {
      throw new ProvisionError(
        'kimi auth preflight sessionDir outside Kimi home/sessions',
      );
    }
    throw new ProvisionError(
      'kimi auth preflight session_index matched no sessionDir',
    );
  }
  if (!matchingSessionDirs.some((dir) => hasWireJsonl(dir))) {
    throw new ProvisionError(
      'kimi auth preflight matching sessionDir produced no wire.jsonl',
    );
  }
}

// realpath when the path exists (resolves symlinks like os.path.realpath /
// Path.resolve), else a plain absolute resolve. Mirrors the Python which uses
// realpath/resolve on session-index paths that should already exist on disk.
function resolveMaybe(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return resolve(p);
  }
}

// Recursively search for any wire.jsonl under a directory (mirrors
// Path.glob("**/wire.jsonl")).
function hasWireJsonl(dir: string): boolean {
  let entries: Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return false;
  }
  for (const entry of entries) {
    if (entry.isFile() && entry.name === 'wire.jsonl') return true;
    if (entry.isDirectory() && hasWireJsonl(join(dir, entry.name))) return true;
  }
  return false;
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

// _kimi_runtime_env_temp_parent: compute a temp-dir parent that is NOT inside the
// run artifact root, so the capture snapshot never sweeps up the mode-0600 secret
// env file. The artifact root is run_dir's parent. If the OS tmpdir (or override)
// resolves inside the artifact root, walk one level above the artifact root. As a
// last-line guard, RAISE if the chosen parent still resolves inside the artifact
// root. Mirrors quorum/kimi.py:_kimi_runtime_env_temp_parent.
function kimiRuntimeEnvTempParent(
  runDir: string,
  tmpDirOverride?: string,
): string {
  const runDirResolved = realpathSync(resolve(runDir));
  const artifactRootResolved = dirname(runDirResolved);
  let tempParent = realpathSync(resolve(tmpDirOverride ?? tmpdir()));
  if (isInsideOrEqual(tempParent, artifactRootResolved)) {
    tempParent = dirname(artifactRootResolved);
  }
  mkdirSync(tempParent, { recursive: true });
  if (isInsideOrEqual(realpathSync(tempParent), artifactRootResolved)) {
    throw new ProvisionError(
      'Kimi runtime env temp directory resolved inside artifact root',
    );
  }
  return tempParent;
}

// Path.is_relative_to semantics: is `candidate` the same as or nested under
// `ancestor`?
function isInsideOrEqual(candidate: string, ancestor: string): boolean {
  return candidate === ancestor || candidate.startsWith(`${ancestor}${sep}`);
}

// write_kimi_runtime_env_file: mode-0600 file of sorted `KEY='value'` shell
// assignments, placed in a run-scoped mkdtemp under a temp parent that is kept
// OUTSIDE the run artifact root (so capture never snapshots the secret). The
// run_dir is threaded so the temp parent and the secret-dir prefix are
// run-scoped. tmpDirOverride exists only for hermetic testing (mirrors the
// Python's tempfile.tempdir monkeypatch). Mirrors write_kimi_runtime_env_file.
export function writeKimiRuntimeEnvFile(
  env: Readonly<Record<string, string>>,
  opts: { readonly runDir: string; readonly tmpDirOverride?: string },
): string {
  const tempParent = kimiRuntimeEnvTempParent(opts.runDir, opts.tmpDirOverride);
  const secretDir = mkdtempSync(
    join(tempParent, `quorum-kimi-env-${basename(opts.runDir)}-`),
  );
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
