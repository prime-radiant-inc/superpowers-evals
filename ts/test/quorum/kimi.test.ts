/**
 * Tests for ts/src/quorum/kimi.ts
 * Ported from tests/quorum/test_kimi.py
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import * as child_process from "node:child_process";
import {
  KimiConfigError,
  kimiPreflightSentinelPayload,
  validateKimiPreflightSentinel,
  sanitizeKimiDiagnostic,
  effectiveKimiModelEnv,
  buildKimiSubprocessEnv,
  kimiStreamJsonReplyOk,
  kimiLogsHaveSuperpowersSessionStart,
  runKimiAuthPreflight,
  ALLOWED_HOST_KIMI_MODEL_ENV,
  DEFAULT_KIMI_MODEL_ENV,
  KIMI_RUNTIME_FLAGS,
  shellAssignment,
  writeKimiRuntimeEnvFile,
  writeEffectiveKimiConfig,
  validateSuperpowersKimiRoot,
  installKimiSuperpowersPlugin,
} from "../../src/quorum/kimi.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "kimi-test-"));
}

function rmrf(p: string): void {
  fs.rmSync(p, { recursive: true, force: true });
}

/** Build a minimal valid superpowers root in tmpPath. */
function makeSuperpowersRoot(tmpPath: string): string {
  const root = path.join(tmpPath, "superpowers");
  fs.mkdirSync(path.join(root, ".kimi-plugin"), { recursive: true });
  fs.mkdirSync(path.join(root, "skills", "using-superpowers"), { recursive: true });
  fs.mkdirSync(path.join(root, "skills", "brainstorming"), { recursive: true });
  fs.writeFileSync(
    path.join(root, ".kimi-plugin", "plugin.json"),
    JSON.stringify({
      name: "superpowers",
      skills: "./skills/",
      sessionStart: { skill: "using-superpowers" },
      skillInstructions: { tools: { Bash: "shell" } },
    }),
  );
  fs.writeFileSync(path.join(root, "skills", "using-superpowers", "SKILL.md"), "skill");
  fs.writeFileSync(path.join(root, "skills", "brainstorming", "SKILL.md"), "skill");
  return root;
}

// ---------------------------------------------------------------------------
// effectiveKimiModelEnv
// ---------------------------------------------------------------------------

describe("effectiveKimiModelEnv", () => {
  test("allows only KIMI_MODEL_API_KEY and KIMI_MODEL_NAME from host", () => {
    expect(() =>
      effectiveKimiModelEnv({
        KIMI_MODEL_API_KEY: "fake-key",
        KIMI_MODEL_NAME: "kimi-custom",
        KIMI_MODEL_BASE_URL: "https://wrong.example",
      }),
    ).toThrow(/KIMI_MODEL_BASE_URL/);
  });

  test("supplies defaults", () => {
    const env = effectiveKimiModelEnv({ KIMI_MODEL_API_KEY: "fake-key" });
    expect(env["KIMI_MODEL_API_KEY"]).toBe("fake-key");
    expect(env["KIMI_MODEL_NAME"]).toBe("kimi-for-coding");
    expect(env["KIMI_MODEL_PROVIDER_TYPE"]).toBe("kimi");
    expect(env["KIMI_MODEL_BASE_URL"]).toBe("https://api.kimi.com/coding/v1");
    expect(env["KIMI_DISABLE_TELEMETRY"]).toBe("1");
    expect(env["KIMI_CODE_BACKGROUND_KEEP_ALIVE_ON_EXIT"]).toBe("false");
  });

  test("requires KIMI_MODEL_API_KEY", () => {
    expect(() => effectiveKimiModelEnv({})).toThrow(/KIMI_MODEL_API_KEY/);
  });

  test("allows custom KIMI_MODEL_NAME", () => {
    const env = effectiveKimiModelEnv({
      KIMI_MODEL_API_KEY: "fake-key",
      KIMI_MODEL_NAME: "kimi-custom",
    });
    expect(env["KIMI_MODEL_NAME"]).toBe("kimi-custom");
  });
});

// ---------------------------------------------------------------------------
// buildKimiSubprocessEnv
// ---------------------------------------------------------------------------

describe("buildKimiSubprocessEnv", () => {
  let tmp: string;
  beforeEach(() => { tmp = makeTmpDir(); });
  afterEach(() => { rmrf(tmp); });

  test("sanitized env drops host state", () => {
    const baseEnv: Record<string, string> = {
      PATH: "/usr/bin:/bin",
      HOME: "/real/home",
      XDG_CONFIG_HOME: "/real/xdg",
      KIMI_CODE_HOME: "/real/kimi",
      MOONSHOT_API_KEY: "do-not-copy",
    };
    const kimiHome = path.join(tmp, "kimi-home");
    const env = buildKimiSubprocessEnv({
      baseEnv,
      kimiHome,
      cwd: path.join(tmp, "cwd"),
      kimiModelEnv: { KIMI_MODEL_API_KEY: "fake-key", KIMI_MODEL_NAME: "kimi" },
    });

    expect(env["PATH"]).toBe("/usr/bin:/bin");
    expect(env["HOME"]).toBe(path.join(kimiHome, "home"));
    expect(env["KIMI_CODE_HOME"]).toBe(kimiHome);
    expect(env["KIMI_CODE_CACHE_DIR"]).toBe(path.join(kimiHome, "cache"));
    expect(env["XDG_CONFIG_HOME"]).toBe(path.join(kimiHome, "xdg-config"));
    expect(env["XDG_CACHE_HOME"]).toBe(path.join(kimiHome, "xdg-cache"));
    expect(env["XDG_DATA_HOME"]).toBe(path.join(kimiHome, "xdg-data"));
    expect("PWD" in env).toBe(false);
    expect("MOONSHOT_API_KEY" in env).toBe(false);
  });

  test("LC_ and proxy vars are forwarded", () => {
    const baseEnv: Record<string, string> = {
      PATH: "/usr/bin",
      LC_ALL: "en_US.UTF-8",
      HTTPS_PROXY: "http://proxy:8080",
    };
    const kimiHome = path.join(tmp, "kimi-home");
    const env = buildKimiSubprocessEnv({
      baseEnv,
      kimiHome,
      cwd: path.join(tmp, "cwd"),
      kimiModelEnv: { KIMI_MODEL_API_KEY: "k" },
    });

    expect(env["LC_ALL"]).toBe("en_US.UTF-8");
    expect(env["HTTPS_PROXY"]).toBe("http://proxy:8080");
  });
});

// ---------------------------------------------------------------------------
// writeKimiRuntimeEnvFile
// ---------------------------------------------------------------------------

describe("writeKimiRuntimeEnvFile", () => {
  let tmp: string;
  beforeEach(() => { tmp = makeTmpDir(); });
  afterEach(() => { rmrf(tmp); });

  test("file is 0600 outside run_dir and sourceable", () => {
    const runDir = path.join(tmp, "results", "run");
    fs.mkdirSync(runDir, { recursive: true });
    const envFile = writeKimiRuntimeEnvFile(
      {
        KIMI_MODEL_API_KEY: "fake key with spaces",
        KIMI_MODEL_NAME: "kimi-for-coding",
      },
      { runDir },
    );

    expect(envFile.startsWith(runDir)).toBe(false);
    const mode = fs.statSync(envFile).mode & 0o777;
    expect(mode).toBe(0o600);

    // Verify it's sourceable via bash
    const script = 'set -a; . "$1"; set +a; printf \'%s\\n\' "$KIMI_MODEL_API_KEY"';
    const result = child_process.spawnSync("bash", ["-c", script, "bash", envFile], {
      encoding: "utf-8",
    });
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe("fake key with spaces");
  });

  test("avoids process temp dir inside run_dir", () => {
    const runDir = path.join(tmp, "results", "run");
    fs.mkdirSync(runDir, { recursive: true });
    const envFile = writeKimiRuntimeEnvFile(
      { KIMI_MODEL_API_KEY: "fake-key" },
      { runDir, tmpDirOverride: runDir },
    );

    const resolvedFile = fs.realpathSync(envFile);
    const resolvedRunDir = fs.realpathSync(runDir);
    expect(resolvedFile.startsWith(resolvedRunDir + path.sep)).toBe(false);
    expect(resolvedFile).not.toBe(resolvedRunDir);
  });

  test("avoids process temp dir inside results root", () => {
    const runDir = path.join(tmp, "results", "run");
    fs.mkdirSync(runDir, { recursive: true });
    const resultsDir = path.join(tmp, "results");
    const envFile = writeKimiRuntimeEnvFile(
      { KIMI_MODEL_API_KEY: "fake-key" },
      { runDir, tmpDirOverride: resultsDir },
    );

    const resolvedFile = fs.realpathSync(envFile);
    const resolvedRunDir = fs.realpathSync(runDir);
    const resolvedResultsDir = fs.realpathSync(resultsDir);
    expect(resolvedFile.startsWith(resolvedRunDir + path.sep)).toBe(false);
    expect(resolvedFile.startsWith(resolvedResultsDir + path.sep)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// writeEffectiveKimiConfig
// ---------------------------------------------------------------------------

describe("writeEffectiveKimiConfig", () => {
  let tmp: string;
  beforeEach(() => { tmp = makeTmpDir(); });
  afterEach(() => { rmrf(tmp); });

  test("redacts API key in summary", () => {
    const p = writeEffectiveKimiConfig(
      tmp,
      {
        KIMI_MODEL_API_KEY: "fake-key",
        KIMI_MODEL_NAME: "kimi-for-coding",
        KIMI_MODEL_PROVIDER_TYPE: "kimi",
      },
      { kimiBinary: "/usr/bin/kimi", kimiVersion: "kimi 0.6.0" },
    );

    const data = JSON.parse(fs.readFileSync(p, "utf-8")) as Record<string, unknown>;
    expect(data["kimi_binary"]).toBe("/usr/bin/kimi");
    expect(data["kimi_version"]).toBe("kimi 0.6.0");
    const modelEnv = data["model_env"] as Record<string, string>;
    expect(modelEnv["KIMI_MODEL_API_KEY"]).toBe("<present>");
    expect(fs.readFileSync(p, "utf-8")).not.toContain("fake-key");
  });

  test("omits non-kimi runtime env", () => {
    const p = writeEffectiveKimiConfig(
      tmp,
      {
        KIMI_MODEL_API_KEY: "fake-key",
        KIMI_MODEL_NAME: "kimi-for-coding",
        KIMI_DISABLE_TELEMETRY: "1",
        HTTPS_PROXY: "secret",
        PATH: "/secret/bin",
        HOME: "/secret/home",
      },
      { kimiBinary: "/usr/bin/kimi", kimiVersion: "kimi 0.6.0" },
    );

    const text = fs.readFileSync(p, "utf-8");
    const data = JSON.parse(text) as Record<string, unknown>;
    const modelEnv = data["model_env"] as Record<string, string>;

    expect(modelEnv["KIMI_MODEL_API_KEY"]).toBe("<present>");
    expect(modelEnv["KIMI_MODEL_NAME"]).toBe("kimi-for-coding");
    expect(modelEnv["KIMI_DISABLE_TELEMETRY"]).toBe("1");
    expect("HTTPS_PROXY" in modelEnv).toBe(false);
    expect("PATH" in modelEnv).toBe(false);
    expect("HOME" in modelEnv).toBe(false);
    expect(text).not.toContain("secret");
    expect(text).not.toContain("/secret/bin");
    expect(text).not.toContain("/secret/home");
  });
});

// ---------------------------------------------------------------------------
// kimiPreflightSentinelPayload + validateKimiPreflightSentinel
// ---------------------------------------------------------------------------

describe("kimiPreflightSentinelPayload / validateKimiPreflightSentinel", () => {
  let tmp: string;
  beforeEach(() => { tmp = makeTmpDir(); });
  afterEach(() => { rmrf(tmp); });

  test("round-trips validation", () => {
    const env = effectiveKimiModelEnv({ KIMI_MODEL_API_KEY: "fake-key" });
    const token = "batch-token";
    const sentinelPath = path.join(tmp, "sentinel.json");
    const payload = kimiPreflightSentinelPayload({
      kimiBinary: "/usr/local/bin/kimi-custom",
      kimiModelEnv: env,
      preflightToken: token,
    });
    fs.writeFileSync(sentinelPath, JSON.stringify(payload) + "\n");

    expect(fs.readFileSync(sentinelPath, "utf-8")).not.toContain(token);
    expect(() =>
      validateKimiPreflightSentinel(sentinelPath, {
        kimiBinary: "/usr/local/bin/kimi-custom",
        kimiModelEnv: env,
        preflightToken: token,
      }),
    ).not.toThrow();
  });

  test("rejects malformed JSON", () => {
    const env = effectiveKimiModelEnv({ KIMI_MODEL_API_KEY: "fake-key" });
    const sentinelPath = path.join(tmp, "sentinel.json");
    fs.writeFileSync(sentinelPath, "{not-json");

    expect(() =>
      validateKimiPreflightSentinel(sentinelPath, {
        kimiBinary: "/usr/local/bin/kimi",
        kimiModelEnv: env,
        preflightToken: "batch-token",
      }),
    ).toThrow(/valid JSON/);
  });

  test("rejects model mismatch", () => {
    const env = effectiveKimiModelEnv({ KIMI_MODEL_API_KEY: "fake-key" });
    const sentinelPath = path.join(tmp, "sentinel.json");
    const payload = kimiPreflightSentinelPayload({
      kimiBinary: "/usr/local/bin/kimi",
      kimiModelEnv: env,
      preflightToken: "batch-token",
    }) as unknown as Record<string, unknown>;
    payload["model"] = "other-model";
    fs.writeFileSync(sentinelPath, JSON.stringify(payload) + "\n");

    expect(() =>
      validateKimiPreflightSentinel(sentinelPath, {
        kimiBinary: "/usr/local/bin/kimi",
        kimiModelEnv: env,
        preflightToken: "batch-token",
      }),
    ).toThrow(/model/);
  });

  test("rejects binary mismatch", () => {
    const env = effectiveKimiModelEnv({ KIMI_MODEL_API_KEY: "fake-key" });
    const sentinelPath = path.join(tmp, "sentinel.json");
    fs.writeFileSync(
      sentinelPath,
      JSON.stringify(
        kimiPreflightSentinelPayload({
          kimiBinary: "/usr/local/bin/kimi-a",
          kimiModelEnv: env,
          preflightToken: "batch-token",
        }),
      ) + "\n",
    );

    expect(() =>
      validateKimiPreflightSentinel(sentinelPath, {
        kimiBinary: "/usr/local/bin/kimi-b",
        kimiModelEnv: env,
        preflightToken: "batch-token",
      }),
    ).toThrow(/kimi_binary/i);
  });

  test("rejects missing token (null)", () => {
    const env = effectiveKimiModelEnv({ KIMI_MODEL_API_KEY: "fake-key" });
    const sentinelPath = path.join(tmp, "sentinel.json");
    fs.writeFileSync(
      sentinelPath,
      JSON.stringify(
        kimiPreflightSentinelPayload({
          kimiBinary: "/usr/local/bin/kimi",
          kimiModelEnv: env,
          preflightToken: "batch-token",
        }),
      ) + "\n",
    );

    expect(() =>
      validateKimiPreflightSentinel(sentinelPath, {
        kimiBinary: "/usr/local/bin/kimi",
        kimiModelEnv: env,
        preflightToken: null,
      }),
    ).toThrow(/token/);
  });

  test("rejects token mismatch", () => {
    const env = effectiveKimiModelEnv({ KIMI_MODEL_API_KEY: "fake-key" });
    const sentinelPath = path.join(tmp, "sentinel.json");
    fs.writeFileSync(
      sentinelPath,
      JSON.stringify(
        kimiPreflightSentinelPayload({
          kimiBinary: "/usr/local/bin/kimi",
          kimiModelEnv: env,
          preflightToken: "batch-token-a",
        }),
      ) + "\n",
    );

    expect(() =>
      validateKimiPreflightSentinel(sentinelPath, {
        kimiBinary: "/usr/local/bin/kimi",
        kimiModelEnv: env,
        preflightToken: "batch-token-b",
      }),
    ).toThrow(/token/i);
  });

  test("rejects missing sentinel file", () => {
    const env = effectiveKimiModelEnv({ KIMI_MODEL_API_KEY: "fake-key" });
    expect(() =>
      validateKimiPreflightSentinel(path.join(tmp, "nonexistent.json"), {
        kimiBinary: "/usr/local/bin/kimi",
        kimiModelEnv: env,
        preflightToken: "batch-token",
      }),
    ).toThrow(/missing/i);
  });
});

// ---------------------------------------------------------------------------
// sanitizeKimiDiagnostic
// ---------------------------------------------------------------------------

describe("sanitizeKimiDiagnostic", () => {
  test("redacts sensitive values", () => {
    const text = sanitizeKimiDiagnostic(
      "preflight failed for fake-secret and token-value but not abc",
      {
        KIMI_MODEL_API_KEY: "fake-secret",
        OTHER_TOKEN: "token-value",
        TINY_KEY: "abc",
      },
    );

    expect(text).not.toContain("fake-secret");
    expect(text).not.toContain("token-value");
    expect(text).toContain("<redacted>");
    expect(text).toContain("abc");
  });

  test("does not redact values shorter than 6 chars", () => {
    const text = sanitizeKimiDiagnostic("short is abc and xy", {
      SOME_KEY: "abc", // 3 chars < 6
      MY_SECRET: "xy", // 2 chars < 6
    });
    expect(text).toContain("abc");
    expect(text).toContain("xy");
  });

  test("redacts by longest value first (no partial leakage)", () => {
    // "secretXY" contains "secret" — must redact "secretXY" first
    const text = sanitizeKimiDiagnostic("the value is secretXY here", {
      MY_KEY: "secret",
      OTHER_TOKEN: "secretXY",
    });
    expect(text).not.toContain("secretXY");
    expect(text).not.toContain("secret");
  });

  test("handles env with no sensitive vars", () => {
    const text = sanitizeKimiDiagnostic("hello world", { PATH: "/usr/bin" });
    expect(text).toBe("hello world");
  });

  test("redacts KIMI_MODEL_API_KEY via name-pattern (contains KEY)", () => {
    const text = sanitizeKimiDiagnostic("key is myapikey123", {
      KIMI_MODEL_API_KEY: "myapikey123",
    });
    expect(text).not.toContain("myapikey123");
    expect(text).toContain("<redacted>");
  });
});

// ---------------------------------------------------------------------------
// validateSuperpowersKimiRoot
// ---------------------------------------------------------------------------

describe("validateSuperpowersKimiRoot", () => {
  let tmp: string;
  beforeEach(() => { tmp = makeTmpDir(); });
  afterEach(() => { rmrf(tmp); });

  test("accepts valid manifest", () => {
    const root = makeSuperpowersRoot(tmp);
    const resolved = validateSuperpowersKimiRoot(root);
    expect(resolved).toBe(fs.realpathSync(root));
  });

  test("rejects wrong sessionStart.skill", () => {
    const root = makeSuperpowersRoot(tmp);
    const manifestPath = path.join(root, ".kimi-plugin", "plugin.json");
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf-8")) as Record<string, unknown>;
    (manifest["sessionStart"] as Record<string, unknown>)["skill"] = "other";
    fs.writeFileSync(manifestPath, JSON.stringify(manifest));

    expect(() => validateSuperpowersKimiRoot(root)).toThrow(/sessionStart.skill/);
  });

  test("rejects missing skill files", () => {
    const root = makeSuperpowersRoot(tmp);
    fs.rmSync(path.join(root, "skills", "brainstorming", "SKILL.md"));

    expect(() => validateSuperpowersKimiRoot(root)).toThrow();
  });

  test("rejects non-existent root", () => {
    expect(() => validateSuperpowersKimiRoot(path.join(tmp, "does-not-exist"))).toThrow();
  });
});

// ---------------------------------------------------------------------------
// installKimiSuperpowersPlugin
// ---------------------------------------------------------------------------

describe("installKimiSuperpowersPlugin", () => {
  let tmp: string;
  beforeEach(() => { tmp = makeTmpDir(); });
  afterEach(() => { rmrf(tmp); });

  test("writes local-path metadata", () => {
    const root = makeSuperpowersRoot(tmp);
    const kimiHome = path.join(tmp, "kimi-home");

    const installedPath = installKimiSuperpowersPlugin(kimiHome, root);

    const installed = JSON.parse(fs.readFileSync(installedPath, "utf-8")) as {
      version: number;
      plugins: Array<{
        id: string;
        enabled: boolean;
        source: string;
        root: string;
      }>;
    };
    expect(installed.version).toBe(1);
    expect(installed.plugins.length).toBe(1);
    const plugin = installed.plugins[0]!;
    expect(plugin.id).toBe("superpowers");
    expect(plugin.enabled).toBe(true);
    expect(plugin.source).toBe("local-path");
    expect(fs.realpathSync(plugin.root)).toBe(fs.realpathSync(root));
    expect(fs.existsSync(path.join(kimiHome, "plugins", "managed", "superpowers"))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// kimiStreamJsonReplyOk
// ---------------------------------------------------------------------------

describe("kimiStreamJsonReplyOk", () => {
  test("accepts assistant type with OK content", () => {
    const stdout = [
      JSON.stringify({ type: "system", message: "ignored" }),
      JSON.stringify({ type: "assistant", content: "OK." }),
    ].join("\n");
    expect(kimiStreamJsonReplyOk(stdout)).toBe(true);
  });

  test("accepts role: assistant with string content", () => {
    const stdout = JSON.stringify({ role: "assistant", content: "OK." });
    expect(kimiStreamJsonReplyOk(stdout)).toBe(true);
  });

  test("accepts role: assistant with array content", () => {
    const stdout = JSON.stringify({
      role: "assistant",
      content: [{ type: "text", text: "O" }, { text: "K!" }],
    });
    expect(kimiStreamJsonReplyOk(stdout)).toBe(true);
  });

  test("ignores tool rows", () => {
    const stdout = JSON.stringify({ type: "message", role: "tool", content: "OK" });
    expect(kimiStreamJsonReplyOk(stdout)).toBe(false);
  });

  test("rejects verbose reply", () => {
    const stdout = JSON.stringify({ type: "assistant", content: "OK, I will do that" });
    expect(kimiStreamJsonReplyOk(stdout)).toBe(false);
  });

  test("accepts OK with trailing period and exclamation", () => {
    expect(kimiStreamJsonReplyOk(JSON.stringify({ role: "assistant", content: "OK!" }))).toBe(true);
    expect(kimiStreamJsonReplyOk(JSON.stringify({ role: "assistant", content: "ok" }))).toBe(true);
    expect(kimiStreamJsonReplyOk(JSON.stringify({ role: "assistant", content: "  OK.  " }))).toBe(true);
  });

  test("handles empty stdout", () => {
    expect(kimiStreamJsonReplyOk("")).toBe(false);
  });

  test("handles non-JSON lines gracefully", () => {
    const stdout = "not-json\n" + JSON.stringify({ role: "assistant", content: "OK" });
    expect(kimiStreamJsonReplyOk(stdout)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// kimiLogsHaveSuperpowersSessionStart
// ---------------------------------------------------------------------------

describe("kimiLogsHaveSuperpowersSessionStart", () => {
  let tmp: string;
  beforeEach(() => { tmp = makeTmpDir(); });
  afterEach(() => { rmrf(tmp); });

  test("detects plugin_session_start event", () => {
    const wire = path.join(tmp, "wire.jsonl");
    fs.writeFileSync(
      wire,
      JSON.stringify({
        type: "context.append_loop_event",
        event: {
          type: "plugin_session_start",
          plugin: "superpowers",
          skill: "using-superpowers",
        },
      }) + "\n",
    );

    expect(kimiLogsHaveSuperpowersSessionStart([wire])).toBe(true);
  });

  test("detects injected message with plugin_session_start content", () => {
    const wire = path.join(tmp, "wire.jsonl");
    fs.writeFileSync(
      wire,
      JSON.stringify({
        type: "context.append_message",
        message: {
          role: "user",
          content: [
            {
              type: "text",
              text: (
                "<system-reminder>\n" +
                "<plugin_session_start>\n" +
                "# Using Superpowers\n" +
                "Path: /tmp/superpowers/skills/" +
                "using-superpowers/SKILL.md\n" +
                "</plugin_session_start>\n" +
                "</system-reminder>"
              ),
            },
          ],
          origin: {
            kind: "injection",
            variant: "plugin_session_start",
          },
        },
      }) + "\n",
    );

    expect(kimiLogsHaveSuperpowersSessionStart([wire])).toBe(true);
  });

  test("rejects missing superpowers session start", () => {
    const wire = path.join(tmp, "wire.jsonl");
    fs.writeFileSync(wire, JSON.stringify({ type: "context.append_loop_event", event: {} }) + "\n");
    expect(kimiLogsHaveSuperpowersSessionStart([wire])).toBe(false);
  });

  test("returns false for missing file", () => {
    expect(kimiLogsHaveSuperpowersSessionStart([path.join(tmp, "nonexistent.jsonl")])).toBe(false);
  });

  test("searches multiple paths", () => {
    const wire1 = path.join(tmp, "wire1.jsonl");
    const wire2 = path.join(tmp, "wire2.jsonl");
    fs.writeFileSync(wire1, JSON.stringify({ type: "unrelated" }) + "\n");
    fs.writeFileSync(
      wire2,
      JSON.stringify({
        type: "context.append_loop_event",
        event: {
          type: "plugin_session_start",
          plugin: "superpowers",
          skill: "using-superpowers",
        },
      }) + "\n",
    );

    expect(kimiLogsHaveSuperpowersSessionStart([wire1, wire2])).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// runKimiAuthPreflight (injectable spawn)
// ---------------------------------------------------------------------------

describe("runKimiAuthPreflight", () => {
  let tmp: string;
  beforeEach(() => { tmp = makeTmpDir(); });
  afterEach(() => { rmrf(tmp); });

  test("uses throwaway home and checks logs", () => {
    const calls: Array<{ cmd: string[]; opts: { cwd: string; env: Record<string, string> } }> = [];

    const fakeSpawn = (
      cmd: string[],
      opts: { cwd: string; env: Record<string, string> },
    ): { exitCode: number; stdout: string; stderr: string } => {
      calls.push({ cmd, opts });
      const kimiHome = opts.env["KIMI_CODE_HOME"]!;
      const cwd = opts.cwd;
      const session = path.join(kimiHome, "sessions", "wd", "session", "agents", "main");
      fs.mkdirSync(session, { recursive: true });
      fs.writeFileSync(path.join(session, "wire.jsonl"), "{}\n");
      fs.writeFileSync(
        path.join(kimiHome, "session_index.jsonl"),
        JSON.stringify({
          sessionDir: path.join(kimiHome, "sessions", "wd", "session"),
          workDir: cwd,
        }) + "\n",
      );
      return {
        exitCode: 0,
        stdout: JSON.stringify({ type: "assistant", content: "OK" }) + "\n",
        stderr: "",
      };
    };

    runKimiAuthPreflight({
      kimiBinary: "kimi",
      kimiModelEnv: { KIMI_MODEL_API_KEY: "fake", KIMI_MODEL_NAME: "kimi" },
      baseEnv: { PATH: "/usr/bin:/bin" },
      spawnFn: fakeSpawn,
    });

    expect(calls.length).toBe(1);
    const { cmd, opts } = calls[0]!;
    expect(cmd).toEqual(["kimi", "-p", "Reply with EXACTLY OK.", "--output-format=stream-json"]);
    expect(path.basename(opts.env["KIMI_CODE_HOME"]!)).toMatch(/^kimi-home/);
    expect(opts.env["KIMI_MODEL_API_KEY"]).toBe("fake");
  });

  test("requires wire.jsonl under matching session dir", () => {
    const fakeSpawn = (
      _cmd: string[],
      opts: { cwd: string; env: Record<string, string> },
    ): { exitCode: number; stdout: string; stderr: string } => {
      const kimiHome = opts.env["KIMI_CODE_HOME"]!;
      const cwd = opts.cwd;
      // Create wire.jsonl under an UNMATCHED session dir
      const unmatchedMain = path.join(kimiHome, "sessions", "other", "session", "agents", "main");
      fs.mkdirSync(unmatchedMain, { recursive: true });
      fs.writeFileSync(path.join(unmatchedMain, "wire.jsonl"), "{}\n");
      // Index points to a matched session dir that has NO wire.jsonl
      const matchedSession = path.join(kimiHome, "sessions", "wd", "session");
      fs.mkdirSync(matchedSession, { recursive: true });
      fs.writeFileSync(
        path.join(kimiHome, "session_index.jsonl"),
        JSON.stringify({ sessionDir: matchedSession, workDir: cwd }) + "\n",
      );
      return {
        exitCode: 0,
        stdout: JSON.stringify({ role: "assistant", content: "OK" }) + "\n",
        stderr: "",
      };
    };

    expect(() =>
      runKimiAuthPreflight({
        kimiBinary: "kimi",
        kimiModelEnv: { KIMI_MODEL_API_KEY: "fake", KIMI_MODEL_NAME: "kimi" },
        baseEnv: { PATH: "/usr/bin:/bin" },
        spawnFn: fakeSpawn,
      }),
    ).toThrow(/matching sessionDir produced no wire\.jsonl/);
  });

  test("rejects matching session dir outside kimi home", () => {
    const externalSession = path.join(tmp, "external-session");

    const fakeSpawn = (
      _cmd: string[],
      opts: { cwd: string; env: Record<string, string> },
    ): { exitCode: number; stdout: string; stderr: string } => {
      const kimiHome = opts.env["KIMI_CODE_HOME"]!;
      const cwd = opts.cwd;
      fs.mkdirSync(kimiHome, { recursive: true });
      const externalMain = path.join(externalSession, "agents", "main");
      fs.mkdirSync(externalMain, { recursive: true });
      fs.writeFileSync(path.join(externalMain, "wire.jsonl"), "{}\n");
      fs.writeFileSync(
        path.join(kimiHome, "session_index.jsonl"),
        JSON.stringify({ sessionDir: externalSession, workDir: cwd }) + "\n",
      );
      return {
        exitCode: 0,
        stdout: JSON.stringify({ role: "assistant", content: "OK" }) + "\n",
        stderr: "",
      };
    };

    expect(() =>
      runKimiAuthPreflight({
        kimiBinary: "kimi",
        kimiModelEnv: { KIMI_MODEL_API_KEY: "fake", KIMI_MODEL_NAME: "kimi" },
        baseEnv: { PATH: "/usr/bin:/bin" },
        spawnFn: fakeSpawn,
      }),
    ).toThrow(/sessionDir.*outside.*Kimi home\/sessions/);
  });

  test("raises on non-zero exit code", () => {
    const fakeSpawn = (
      _cmd: string[],
      _opts: { cwd: string; env: Record<string, string> },
    ): { exitCode: number; stdout: string; stderr: string } => {
      return { exitCode: 1, stdout: "", stderr: "auth failed" };
    };

    expect(() =>
      runKimiAuthPreflight({
        kimiBinary: "kimi",
        kimiModelEnv: { KIMI_MODEL_API_KEY: "fake", KIMI_MODEL_NAME: "kimi" },
        baseEnv: { PATH: "/usr/bin:/bin" },
        spawnFn: fakeSpawn,
      }),
    ).toThrow(/preflight failed/);
  });

  test("raises when reply is not OK", () => {
    const fakeSpawn = (
      _cmd: string[],
      opts: { cwd: string; env: Record<string, string> },
    ): { exitCode: number; stdout: string; stderr: string } => {
      const kimiHome = opts.env["KIMI_CODE_HOME"]!;
      fs.mkdirSync(kimiHome, { recursive: true });
      return {
        exitCode: 0,
        stdout: JSON.stringify({ role: "assistant", content: "Sure, I'll do something" }) + "\n",
        stderr: "",
      };
    };

    expect(() =>
      runKimiAuthPreflight({
        kimiBinary: "kimi",
        kimiModelEnv: { KIMI_MODEL_API_KEY: "fake", KIMI_MODEL_NAME: "kimi" },
        baseEnv: { PATH: "/usr/bin:/bin" },
        spawnFn: fakeSpawn,
      }),
    ).toThrow(/did not return OK/);
  });

  test("raises when session_index.jsonl is missing", () => {
    const fakeSpawn = (
      _cmd: string[],
      opts: { cwd: string; env: Record<string, string> },
    ): { exitCode: number; stdout: string; stderr: string } => {
      const kimiHome = opts.env["KIMI_CODE_HOME"]!;
      fs.mkdirSync(kimiHome, { recursive: true });
      return {
        exitCode: 0,
        stdout: JSON.stringify({ role: "assistant", content: "OK" }) + "\n",
        stderr: "",
      };
    };

    expect(() =>
      runKimiAuthPreflight({
        kimiBinary: "kimi",
        kimiModelEnv: { KIMI_MODEL_API_KEY: "fake", KIMI_MODEL_NAME: "kimi" },
        baseEnv: { PATH: "/usr/bin:/bin" },
        spawnFn: fakeSpawn,
      }),
    ).toThrow(/session_index\.jsonl/);
  });

  test("raises when workDir does not match cwd", () => {
    const fakeSpawn = (
      _cmd: string[],
      opts: { cwd: string; env: Record<string, string> },
    ): { exitCode: number; stdout: string; stderr: string } => {
      const kimiHome = opts.env["KIMI_CODE_HOME"]!;
      fs.mkdirSync(kimiHome, { recursive: true });
      fs.writeFileSync(
        path.join(kimiHome, "session_index.jsonl"),
        JSON.stringify({
          sessionDir: path.join(kimiHome, "sessions", "x"),
          workDir: "/wrong/dir",
        }) + "\n",
      );
      return {
        exitCode: 0,
        stdout: JSON.stringify({ role: "assistant", content: "OK" }) + "\n",
        stderr: "",
      };
    };

    expect(() =>
      runKimiAuthPreflight({
        kimiBinary: "kimi",
        kimiModelEnv: { KIMI_MODEL_API_KEY: "fake", KIMI_MODEL_NAME: "kimi" },
        baseEnv: { PATH: "/usr/bin:/bin" },
        spawnFn: fakeSpawn,
      }),
    ).toThrow(/workDir/);
  });
});

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

describe("constants", () => {
  test("ALLOWED_HOST_KIMI_MODEL_ENV contains expected keys", () => {
    expect(ALLOWED_HOST_KIMI_MODEL_ENV.has("KIMI_MODEL_API_KEY")).toBe(true);
    expect(ALLOWED_HOST_KIMI_MODEL_ENV.has("KIMI_MODEL_NAME")).toBe(true);
    expect(ALLOWED_HOST_KIMI_MODEL_ENV.size).toBe(2);
  });

  test("DEFAULT_KIMI_MODEL_ENV has expected keys", () => {
    expect(DEFAULT_KIMI_MODEL_ENV["KIMI_MODEL_NAME"]).toBe("kimi-for-coding");
    expect(DEFAULT_KIMI_MODEL_ENV["KIMI_MODEL_PROVIDER_TYPE"]).toBe("kimi");
    expect(DEFAULT_KIMI_MODEL_ENV["KIMI_MODEL_BASE_URL"]).toBe("https://api.kimi.com/coding/v1");
  });

  test("KIMI_RUNTIME_FLAGS has expected keys", () => {
    expect(KIMI_RUNTIME_FLAGS["KIMI_DISABLE_TELEMETRY"]).toBe("1");
    expect(KIMI_RUNTIME_FLAGS["KIMI_DISABLE_CRON"]).toBe("1");
    expect(KIMI_RUNTIME_FLAGS["KIMI_CODE_BACKGROUND_KEEP_ALIVE_ON_EXIT"]).toBe("false");
  });
});

// ---------------------------------------------------------------------------
// shellAssignment
// ---------------------------------------------------------------------------

describe("shellAssignment", () => {
  test("produces KEY=value assignment for simple values", () => {
    expect(shellAssignment("FOO", "bar")).toBe("FOO=bar");
  });

  test("quotes values with spaces", () => {
    const result = shellAssignment("KEY", "value with spaces");
    expect(result).toMatch(/^KEY=/);
    // The value must be present (quoted or escaped)
    expect(result).toContain("value with spaces");
  });

  test("quotes values with special chars", () => {
    const result = shellAssignment("KEY", "it's");
    expect(result).toMatch(/^KEY=/);
  });
});
