/**
 * Kimi coding-agent provisioning helpers.
 *
 * Port of quorum/kimi.py — parity-locked by ts/test/quorum/kimi.test.ts.
 *
 * Public API mirrors the Python module exactly:
 *   KimiConfigError, resolveKimiBinary, kimiPreflightSentinelPayload,
 *   validateKimiPreflightSentinel, sanitizeKimiDiagnostic,
 *   effectiveKimiModelEnv, buildKimiSubprocessEnv, kimiStreamJsonReplyOk,
 *   kimiLogsHaveSuperpowersSessionStart, runKimiAuthPreflight,
 *   ALLOWED_HOST_KIMI_MODEL_ENV, DEFAULT_KIMI_MODEL_ENV, KIMI_RUNTIME_FLAGS,
 *   shellAssignment, writeKimiRuntimeEnvFile, writeEffectiveKimiConfig,
 *   validateSuperpowersKimiRoot, installKimiSuperpowersPlugin.
 *
 * SECURITY NOTE: sanitizeKimiDiagnostic redacts values of env vars whose
 * names contain KEY/TOKEN/SECRET/PASSWORD when the value is ≥6 chars.
 * Redaction applies longest-match-first to prevent partial leakage.
 */

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";

// ---------------------------------------------------------------------------
// Error
// ---------------------------------------------------------------------------

export class KimiConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "KimiConfigError";
  }
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const ALLOWED_HOST_KIMI_MODEL_ENV: ReadonlySet<string> = new Set([
  "KIMI_MODEL_API_KEY",
  "KIMI_MODEL_NAME",
]);

export const DEFAULT_KIMI_MODEL_ENV: Readonly<Record<string, string>> = {
  KIMI_MODEL_NAME: "kimi-for-coding",
  KIMI_MODEL_PROVIDER_TYPE: "kimi",
  KIMI_MODEL_BASE_URL: "https://api.kimi.com/coding/v1",
  KIMI_MODEL_MAX_CONTEXT_SIZE: "262144",
  KIMI_MODEL_CAPABILITIES: "thinking,image_in,video_in,tool_use",
  KIMI_MODEL_DEFAULT_THINKING: "true",
};

export const KIMI_RUNTIME_FLAGS: Readonly<Record<string, string>> = {
  KIMI_DISABLE_TELEMETRY: "1",
  KIMI_DISABLE_CRON: "1",
  KIMI_CODE_BACKGROUND_KEEP_ALIVE_ON_EXIT: "false",
};

const KIMI_CONFIG_SUMMARY_ENV: ReadonlySet<string> = new Set([
  ...Object.keys(DEFAULT_KIMI_MODEL_ENV),
  ...Object.keys(KIMI_RUNTIME_FLAGS),
  "KIMI_MODEL_API_KEY",
]);

/** Substrings that flag an env var name as sensitive (checked uppercase). */
const SENSITIVE_ENV_NAME_PARTS = ["KEY", "TOKEN", "SECRET", "PASSWORD"] as const;

const MIN_SENSITIVE_VALUE_LEN = 6;

// ---------------------------------------------------------------------------
// resolveKimiBinary
// ---------------------------------------------------------------------------

/**
 * Resolve the kimi binary path via PATH. Throws KimiConfigError if not found.
 */
export function resolveKimiBinary(binary: string): string {
  // Use `which` on Unix to locate the binary.
  const result = spawnSync("which", [binary], { encoding: "utf-8" });
  const found = result.stdout.trim();
  if (result.status !== 0 || !found) {
    throw new KimiConfigError(`${JSON.stringify(binary)} not found on PATH; cannot run Kimi evals`);
  }
  return found;
}

// ---------------------------------------------------------------------------
// kimiPreflightSentinelPayload
// ---------------------------------------------------------------------------

export interface KimiPreflightSentinelPayload {
  schema: number;
  agent: string;
  kimi_binary: string;
  model: string;
  provider: string;
  base_url: string;
  preflight_token_sha256: string;
}

/**
 * Build the sentinel payload dict. Token is stored as a SHA-256 hash only.
 */
export function kimiPreflightSentinelPayload(opts: {
  kimiBinary: string;
  kimiModelEnv: Readonly<Record<string, string>>;
  preflightToken: string;
}): KimiPreflightSentinelPayload {
  const { kimiBinary, kimiModelEnv, preflightToken } = opts;
  const tokenHash = crypto.createHash("sha256").update(preflightToken).digest("hex");
  return {
    schema: 1,
    agent: "kimi",
    kimi_binary: kimiBinary,
    model: kimiModelEnv["KIMI_MODEL_NAME"] ?? "",
    provider: kimiModelEnv["KIMI_MODEL_PROVIDER_TYPE"] ?? "",
    base_url: kimiModelEnv["KIMI_MODEL_BASE_URL"] ?? "",
    preflight_token_sha256: tokenHash,
  };
}

// ---------------------------------------------------------------------------
// validateKimiPreflightSentinel
// ---------------------------------------------------------------------------

/**
 * Validate that the sentinel file at `sentinelPath` matches the expected
 * payload. Throws KimiConfigError on any mismatch or read failure.
 */
export function validateKimiPreflightSentinel(
  sentinelPath: string,
  opts: {
    kimiBinary: string;
    kimiModelEnv: Readonly<Record<string, string>>;
    preflightToken: string | null;
  },
): void {
  const { kimiBinary, kimiModelEnv, preflightToken } = opts;

  if (!fs.existsSync(sentinelPath) || !fs.statSync(sentinelPath).isFile()) {
    throw new KimiConfigError(`Kimi preflight sentinel missing: ${sentinelPath}`);
  }

  let raw: string;
  try {
    raw = fs.readFileSync(sentinelPath, "utf-8");
  } catch (e) {
    throw new KimiConfigError(`Kimi preflight sentinel could not be read: ${String(e)}`);
  }

  let payload: unknown;
  try {
    payload = JSON.parse(raw);
  } catch (e) {
    throw new KimiConfigError(`Kimi preflight sentinel is not valid JSON: ${String(e)}`);
  }

  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
    throw new KimiConfigError("Kimi preflight sentinel must be a JSON object");
  }

  if (preflightToken === null || preflightToken.trim() === "") {
    throw new KimiConfigError("Kimi preflight sentinel token missing or malformed");
  }

  const expected = kimiPreflightSentinelPayload({ kimiBinary, kimiModelEnv, preflightToken });
  const payloadRecord = payload as Record<string, unknown>;

  for (const [key, expectedValue] of Object.entries(expected)) {
    const actual = payloadRecord[key];
    if (actual !== expectedValue) {
      throw new KimiConfigError(
        `Kimi preflight sentinel ${key} mismatch: expected ${JSON.stringify(expectedValue)}, got ${JSON.stringify(actual)}`,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// sanitizeKimiDiagnostic  (SECURITY-RELEVANT)
// ---------------------------------------------------------------------------

/**
 * Redact sensitive values from a diagnostic message.
 *
 * Any env var whose NAME (uppercased) contains KEY, TOKEN, SECRET, or PASSWORD
 * and whose VALUE is ≥6 characters is redacted. Redaction proceeds
 * longest-value-first to prevent partial leakage of substrings.
 */
export function sanitizeKimiDiagnostic(
  message: unknown,
  env: Readonly<Record<string, string>> = process.env as Record<string, string>,
): string {
  let text = String(message);
  const sensitiveValues = new Set<string>();

  for (const [key, value] of Object.entries(env)) {
    if (
      value &&
      value.length >= MIN_SENSITIVE_VALUE_LEN &&
      SENSITIVE_ENV_NAME_PARTS.some((part) => key.toUpperCase().includes(part))
    ) {
      sensitiveValues.add(value);
    }
  }

  // Sort longest first to avoid partial-match survivors
  const orderedValues = [...sensitiveValues].sort((a, b) => b.length - a.length);
  for (const value of orderedValues) {
    text = text.split(value).join("<redacted>");
  }
  return text;
}

// ---------------------------------------------------------------------------
// effectiveKimiModelEnv
// ---------------------------------------------------------------------------

/**
 * Merge host overrides (only KIMI_MODEL_API_KEY and KIMI_MODEL_NAME allowed)
 * with defaults and runtime flags. Returns the complete env for kimi.
 */
export function effectiveKimiModelEnv(env: Readonly<Record<string, string>>): Record<string, string> {
  const unknown = Object.keys(env)
    .filter((k) => k.startsWith("KIMI_MODEL_") && !ALLOWED_HOST_KIMI_MODEL_ENV.has(k))
    .sort();
  if (unknown.length > 0) {
    throw new KimiConfigError("unsupported host KIMI_MODEL_* override(s): " + unknown.join(", "));
  }

  const apiKey = env["KIMI_MODEL_API_KEY"];
  if (!apiKey) {
    throw new KimiConfigError("KIMI_MODEL_API_KEY is required for Kimi evals");
  }

  const merged: Record<string, string> = { ...DEFAULT_KIMI_MODEL_ENV, ...KIMI_RUNTIME_FLAGS };
  merged["KIMI_MODEL_API_KEY"] = apiKey;
  if (env["KIMI_MODEL_NAME"]) {
    merged["KIMI_MODEL_NAME"] = env["KIMI_MODEL_NAME"]!;
  }
  return merged;
}

// ---------------------------------------------------------------------------
// buildKimiSubprocessEnv
// ---------------------------------------------------------------------------

/**
 * Build a clean subprocess env for kimi. Only PATH, TERM, LANG, SHELL,
 * LC_* vars, and *_proxy vars are forwarded from the host. Kimi-specific
 * paths are derived from kimiHome; kimiModelEnv is merged in.
 */
export function buildKimiSubprocessEnv(opts: {
  baseEnv: Readonly<Record<string, string>>;
  kimiHome: string;
  cwd: string;
  kimiModelEnv: Readonly<Record<string, string>>;
}): Record<string, string> {
  const { baseEnv, kimiHome, kimiModelEnv } = opts;
  const allowExact = new Set(["PATH", "TERM", "LANG", "SHELL"]);

  const out: Record<string, string> = {};

  for (const [key, value] of Object.entries(baseEnv)) {
    if (allowExact.has(key)) {
      out[key] = value;
    }
  }

  for (const [key, value] of Object.entries(baseEnv)) {
    if (key.startsWith("LC_") || key.toLowerCase().endsWith("_proxy")) {
      out[key] = value;
    }
  }

  Object.assign(out, kimiModelEnv);

  out["HOME"] = path.join(kimiHome, "home");
  out["KIMI_CODE_HOME"] = kimiHome;
  out["KIMI_CODE_CACHE_DIR"] = path.join(kimiHome, "cache");
  out["XDG_CONFIG_HOME"] = path.join(kimiHome, "xdg-config");
  out["XDG_CACHE_HOME"] = path.join(kimiHome, "xdg-cache");
  out["XDG_DATA_HOME"] = path.join(kimiHome, "xdg-data");

  return out;
}

// ---------------------------------------------------------------------------
// shellAssignment
// ---------------------------------------------------------------------------

/**
 * Produce a POSIX shell assignment string: KEY='value' (single-quote escaped).
 * Mirrors Python's `shlex.quote` behaviour.
 */
export function shellAssignment(key: string, value: string): string {
  // shlex.quote wraps in single quotes and escapes existing single quotes.
  // A plain alphanumeric value with no special chars is left bare by shlex.quote.
  // We replicate: if safe (matches /^[a-zA-Z0-9@%+=:,./-]+$/), output bare;
  // otherwise wrap in single quotes, replacing ' with '"'"'.
  const safePattern = /^[a-zA-Z0-9@%+=:,./-]+$/;
  if (safePattern.test(value)) {
    return `${key}=${value}`;
  }
  const escaped = value.replace(/'/g, "'\"'\"'");
  return `${key}='${escaped}'`;
}

// ---------------------------------------------------------------------------
// _kimiRuntimeEnvTempParent  (internal)
// ---------------------------------------------------------------------------

/**
 * Determine a temp directory parent that is NOT inside the artifact root
 * (runDir's parent). Mirrors Python's `_kimi_runtime_env_temp_parent`.
 */
function kimiRuntimeEnvTempParent(runDir: string, tmpDirOverride?: string): string {
  const runDirResolved = fs.realpathSync(runDir);
  const artifactRootResolved = path.resolve(runDirResolved, "..");

  let tempParent = fs.realpathSync(tmpDirOverride ?? os.tmpdir());

  // If temp is inside artifact root, go one level higher.
  if (tempParent.startsWith(artifactRootResolved + path.sep) || tempParent === artifactRootResolved) {
    tempParent = path.resolve(artifactRootResolved, "..");
  }

  fs.mkdirSync(tempParent, { recursive: true });

  const resolvedTemp = fs.realpathSync(tempParent);
  if (
    resolvedTemp.startsWith(artifactRootResolved + path.sep) ||
    resolvedTemp === artifactRootResolved
  ) {
    throw new KimiConfigError("Kimi runtime env temp directory resolved inside artifact root");
  }

  return tempParent;
}

// ---------------------------------------------------------------------------
// writeKimiRuntimeEnvFile
// ---------------------------------------------------------------------------

/**
 * Write an env file (mode 0600) outside the run directory.
 * Accepts an optional tmpDirOverride for testability (mirrors Python's
 * monkeypatch of tempfile.tempdir).
 */
export function writeKimiRuntimeEnvFile(
  env: Readonly<Record<string, string>>,
  opts: { runDir: string; tmpDirOverride?: string },
): string {
  const { runDir, tmpDirOverride } = opts;
  const tempParent = kimiRuntimeEnvTempParent(runDir, tmpDirOverride);

  const secretDir = fs.mkdtempSync(
    path.join(tempParent, `quorum-kimi-env-${path.basename(runDir)}-`),
  );
  const filePath = path.join(secretDir, "kimi-runtime.env");

  const lines = Object.keys(env)
    .sort()
    .map((k) => shellAssignment(k, env[k]!) + "\n")
    .join("");
  fs.writeFileSync(filePath, lines, { mode: 0o600 });
  return filePath;
}

// ---------------------------------------------------------------------------
// writeEffectiveKimiConfig
// ---------------------------------------------------------------------------

/**
 * Write a summary of the effective kimi config to kimiHome/effective-kimi-model-config.json.
 * API key is redacted to "<present>". Non-kimi-runtime env vars are omitted.
 */
export function writeEffectiveKimiConfig(
  kimiHome: string,
  env: Readonly<Record<string, string>>,
  opts: { kimiBinary: string | null; kimiVersion: string | null },
): string {
  const { kimiBinary, kimiVersion } = opts;

  const modelEnv: Record<string, string> = {};
  for (const key of [...Object.keys(env)].sort()) {
    if (KIMI_CONFIG_SUMMARY_ENV.has(key)) {
      modelEnv[key] = key === "KIMI_MODEL_API_KEY" ? "<present>" : (env[key] ?? "");
    }
  }

  const payload = { kimi_binary: kimiBinary, kimi_version: kimiVersion, model_env: modelEnv };
  const outPath = path.join(kimiHome, "effective-kimi-model-config.json");
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(payload, null, 2) + "\n");
  return outPath;
}

// ---------------------------------------------------------------------------
// Internal helpers for stream-json parsing
// ---------------------------------------------------------------------------

function normalizedOk(text: string): boolean {
  return text.trim().replace(/[.!]+$/, "").trim().toUpperCase() === "OK";
}

// ---------------------------------------------------------------------------
// kimiStreamJsonReplyOk
// ---------------------------------------------------------------------------

/**
 * Return true iff the kimi --output-format=stream-json stdout contains an
 * assistant message whose concatenated text content normalises to "OK".
 */
export function kimiStreamJsonReplyOk(stdout: string): boolean {
  const assistantParts: string[] = [];

  for (const line of stdout.split("\n")) {
    if (!line.trim()) continue;
    let row: unknown;
    try {
      row = JSON.parse(line);
    } catch {
      continue;
    }
    if (row === null || typeof row !== "object" || Array.isArray(row)) continue;
    const r = row as Record<string, unknown>;

    const role = r["role"];
    let isAssistant: boolean;
    if (role !== undefined) {
      isAssistant = role === "assistant";
    } else {
      isAssistant = ["assistant", "message", "response"].includes(r["type"] as string);
    }

    if (isAssistant) {
      const content = r["content"];
      if (typeof content === "string") {
        assistantParts.push(content);
      } else if (Array.isArray(content)) {
        for (const part of content) {
          if (part !== null && typeof part === "object" && !Array.isArray(part)) {
            const p = part as Record<string, unknown>;
            if (typeof p["text"] === "string") {
              assistantParts.push(p["text"]);
            }
          }
        }
      }
    }
  }

  return normalizedOk(assistantParts.join(""));
}

// ---------------------------------------------------------------------------
// Internal helpers for session-log parsing
// ---------------------------------------------------------------------------

function kimiMessageText(row: Record<string, unknown>): string {
  const messageObj = row["message"];
  if (messageObj === null || typeof messageObj !== "object" || Array.isArray(messageObj)) return "";
  const message = messageObj as Record<string, unknown>;
  const content = message["content"];
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const part of content) {
    if (typeof part === "string") {
      parts.push(part);
    } else if (part !== null && typeof part === "object" && !Array.isArray(part)) {
      const p = part as Record<string, unknown>;
      if (typeof p["text"] === "string") {
        parts.push(p["text"]);
      }
    }
  }
  return parts.join("\n");
}

function kimiInjectionOrigin(row: Record<string, unknown>): unknown {
  const origin = row["origin"];
  if (origin !== undefined) return origin;
  const messageObj = row["message"];
  if (messageObj !== null && typeof messageObj === "object" && !Array.isArray(messageObj)) {
    return (messageObj as Record<string, unknown>)["origin"];
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// kimiLogsHaveSuperpowersSessionStart
// ---------------------------------------------------------------------------

/**
 * Return true iff any of the given wire.jsonl paths contain evidence that
 * the superpowers plugin's using-superpowers session-start was injected.
 */
export function kimiLogsHaveSuperpowersSessionStart(paths: string[]): boolean {
  for (const filePath of paths) {
    let lines: string[];
    try {
      lines = fs.readFileSync(filePath, "utf-8").split("\n");
    } catch {
      continue;
    }

    for (const line of lines) {
      if (!line.trim()) continue;
      let row: unknown;
      try {
        row = JSON.parse(line);
      } catch {
        continue;
      }
      if (row === null || typeof row !== "object" || Array.isArray(row)) continue;
      const r = row as Record<string, unknown>;

      // Check for structured plugin_session_start event
      const event = r["event"];
      if (event !== null && typeof event === "object" && !Array.isArray(event)) {
        const ev = event as Record<string, unknown>;
        if (
          ev["type"] === "plugin_session_start" &&
          ev["plugin"] === "superpowers" &&
          ev["skill"] === "using-superpowers"
        ) {
          return true;
        }
      }

      // Check for injection origin + content text
      const origin = kimiInjectionOrigin(r);
      if (origin !== null && typeof origin === "object" && !Array.isArray(origin)) {
        const originDict = origin as Record<string, unknown>;
        if (
          originDict["kind"] === "injection" &&
          originDict["variant"] === "plugin_session_start"
        ) {
          const text = kimiMessageText(r);
          const lowerText = text.toLowerCase();
          if (
            text.includes("<plugin_session_start") &&
            lowerText.includes("superpowers") &&
            lowerText.includes("using-superpowers")
          ) {
            return true;
          }
        }
      }
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// runKimiAuthPreflight
// ---------------------------------------------------------------------------

/** Signature of the injectable spawn function for testing. */
export type KimiSpawnFn = (
  cmd: string[],
  opts: { cwd: string; env: Record<string, string> },
) => { exitCode: number; stdout: string; stderr: string };

/** Default spawn implementation using child_process.spawnSync. */
function defaultSpawnFn(
  cmd: string[],
  opts: { cwd: string; env: Record<string, string> },
): { exitCode: number; stdout: string; stderr: string } {
  const result = spawnSync(cmd[0]!, cmd.slice(1), {
    cwd: opts.cwd,
    env: opts.env,
    encoding: "utf-8",
    maxBuffer: 10 * 1024 * 1024,
  });
  return {
    exitCode: result.status ?? 1,
    stdout: (result.stdout as string) ?? "",
    stderr: (result.stderr as string) ?? "",
  };
}

/**
 * Run a quick kimi auth preflight: spawn kimi with a throwaway home, ask it
 * to reply "OK", verify the reply and that session logs were written.
 *
 * Takes an optional spawnFn for testability (mirrors Python's monkeypatch of
 * subprocess.run).
 */
export function runKimiAuthPreflight(opts: {
  kimiBinary: string;
  kimiModelEnv: Readonly<Record<string, string>>;
  baseEnv: Readonly<Record<string, string>>;
  timeout?: number;
  spawnFn?: KimiSpawnFn;
}): void {
  const { kimiBinary, kimiModelEnv, baseEnv, spawnFn = defaultSpawnFn } = opts;

  // Create a throwaway temporary directory tree
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "quorum-kimi-preflight-"));
  try {
    const kimiHome = path.join(tmpRoot, "kimi-home");
    const cwd = path.join(tmpRoot, "cwd");
    fs.mkdirSync(cwd, { recursive: true });

    const env = buildKimiSubprocessEnv({
      baseEnv: baseEnv as Record<string, string>,
      kimiHome,
      cwd,
      kimiModelEnv: kimiModelEnv as Record<string, string>,
    });

    const result = spawnFn(
      [kimiBinary, "-p", "Reply with EXACTLY OK.", "--output-format=stream-json"],
      { cwd, env },
    );

    if (result.exitCode !== 0) {
      const stderr = result.stderr.trim().slice(0, 300);
      throw new KimiConfigError(
        `kimi auth preflight failed (exit ${result.exitCode}); stderr: ${stderr}`,
      );
    }

    if (!kimiStreamJsonReplyOk(result.stdout)) {
      throw new KimiConfigError(
        "kimi auth preflight did not return OK; stdout: " + result.stdout.trim().slice(0, 300),
      );
    }

    const indexPath = path.join(kimiHome, "session_index.jsonl");
    if (!fs.existsSync(indexPath) || !fs.statSync(indexPath).isFile()) {
      throw new KimiConfigError("kimi auth preflight produced no session_index.jsonl");
    }

    const target = fs.realpathSync(cwd);
    const sessionsRoot = fs.existsSync(path.join(kimiHome, "sessions"))
      ? fs.realpathSync(path.join(kimiHome, "sessions"))
      : path.resolve(kimiHome, "sessions");

    let matchedWorkdir = false;
    let outsideSessionDir = false;
    const matchingSessionDirs: string[] = [];

    for (const line of fs.readFileSync(indexPath, "utf-8").split("\n")) {
      if (!line.trim()) continue;
      let row: unknown;
      try {
        row = JSON.parse(line);
      } catch {
        continue;
      }
      if (row === null || typeof row !== "object" || Array.isArray(row)) continue;
      const r = row as Record<string, unknown>;
      const workDir = r["workDir"];
      if (typeof workDir !== "string") continue;

      let resolvedWorkDir: string;
      try {
        resolvedWorkDir = fs.realpathSync(workDir);
      } catch {
        resolvedWorkDir = path.resolve(workDir);
      }

      if (resolvedWorkDir !== target) continue;

      matchedWorkdir = true;
      const sessionDir = r["sessionDir"];
      if (typeof sessionDir !== "string" || !sessionDir) continue;

      let resolvedSessionDir: string;
      try {
        resolvedSessionDir = fs.realpathSync(sessionDir);
      } catch {
        resolvedSessionDir = path.resolve(sessionDir);
      }

      // Security check: session dir must be inside kimi home/sessions
      if (
        !resolvedSessionDir.startsWith(sessionsRoot + path.sep) &&
        resolvedSessionDir !== sessionsRoot
      ) {
        outsideSessionDir = true;
        continue;
      }

      matchingSessionDirs.push(resolvedSessionDir);
    }

    if (!matchedWorkdir) {
      throw new KimiConfigError(
        "kimi auth preflight session_index workDir did not match cwd",
      );
    }

    if (matchingSessionDirs.length === 0) {
      if (outsideSessionDir) {
        throw new KimiConfigError(
          "kimi auth preflight sessionDir outside Kimi home/sessions",
        );
      }
      throw new KimiConfigError(
        "kimi auth preflight session_index matched no sessionDir",
      );
    }

    // Check that at least one matching session dir has a wire.jsonl
    let foundWire = false;
    for (const sessionDir of matchingSessionDirs) {
      if (globHasWireJsonl(sessionDir)) {
        foundWire = true;
        break;
      }
    }

    if (!foundWire) {
      throw new KimiConfigError(
        "kimi auth preflight matching sessionDir produced no wire.jsonl",
      );
    }
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
}

/** Recursively search for any wire.jsonl under a directory. */
function globHasWireJsonl(dir: string): boolean {
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isFile() && entry.name === "wire.jsonl") return true;
      if (entry.isDirectory()) {
        if (globHasWireJsonl(path.join(dir, entry.name))) return true;
      }
    }
  } catch {
    // ignore unreadable dirs
  }
  return false;
}

// ---------------------------------------------------------------------------
// validateSuperpowersKimiRoot
// ---------------------------------------------------------------------------

/**
 * Validate that `root` is a Superpowers checkout with a valid .kimi-plugin
 * manifest. Returns the resolved absolute path.
 */
export function validateSuperpowersKimiRoot(root: string): string {
  const resolved = path.resolve(root);

  if (!fs.existsSync(resolved)) {
    throw new KimiConfigError(`SUPERPOWERS_ROOT missing Kimi files: ${root}`);
  }

  const manifestPath = path.join(resolved, ".kimi-plugin", "plugin.json");
  const required = [
    manifestPath,
    path.join(resolved, "skills", "using-superpowers", "SKILL.md"),
    path.join(resolved, "skills", "brainstorming", "SKILL.md"),
  ];

  const missing = required.filter((p) => !fs.existsSync(p) || !fs.statSync(p).isFile());
  if (missing.length > 0) {
    const relMissing = missing.map((p) => path.relative(resolved, p));
    throw new KimiConfigError("SUPERPOWERS_ROOT missing Kimi files: " + relMissing.join(", "));
  }

  let manifest: unknown;
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, "utf-8"));
  } catch (e) {
    throw new KimiConfigError(`${manifestPath} is not valid JSON: ${String(e)}`);
  }

  if (manifest === null || typeof manifest !== "object" || Array.isArray(manifest)) {
    throw new KimiConfigError("Kimi manifest must be a JSON object");
  }
  const m = manifest as Record<string, unknown>;

  if (m["name"] !== "superpowers") {
    throw new KimiConfigError("Kimi manifest name must be superpowers");
  }
  if (m["skills"] !== "./skills/") {
    throw new KimiConfigError("Kimi manifest skills must be ./skills/");
  }

  const sessionStart = m["sessionStart"];
  if (
    sessionStart === null ||
    typeof sessionStart !== "object" ||
    Array.isArray(sessionStart) ||
    (sessionStart as Record<string, unknown>)["skill"] !== "using-superpowers"
  ) {
    throw new KimiConfigError("Kimi manifest sessionStart.skill must be using-superpowers");
  }

  if (!m["skillInstructions"]) {
    throw new KimiConfigError("Kimi manifest skillInstructions must be non-empty");
  }

  return fs.realpathSync(resolved);
}

// ---------------------------------------------------------------------------
// installKimiSuperpowersPlugin
// ---------------------------------------------------------------------------

/**
 * Install the superpowers plugin into a kimi home directory by writing
 * plugins/installed.json.
 */
export function installKimiSuperpowersPlugin(kimiHome: string, superpowersRoot: string): string {
  const root = validateSuperpowersKimiRoot(superpowersRoot);

  const pluginsDir = path.join(kimiHome, "plugins");
  fs.mkdirSync(pluginsDir, { recursive: true });

  const now = new Date().toISOString().replace(/\.\d{3}Z$/, ".000Z");

  const payload = {
    version: 1,
    plugins: [
      {
        id: "superpowers",
        root,
        source: "local-path",
        enabled: true,
        installedAt: now,
        updatedAt: now,
        originalSource: root,
      },
    ],
  };

  const outPath = path.join(pluginsDir, "installed.json");
  fs.writeFileSync(outPath, JSON.stringify(payload, null, 2) + "\n");
  return outPath;
}
