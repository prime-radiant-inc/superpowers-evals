/**
 * Tests for the unified normalize.ts CLI.
 *
 * Each test spawns the CLI with a real fixture and asserts it:
 *  - exits 0
 *  - prints valid ATIF JSON with schema_version "ATIF-v1.7"
 *
 * Covered agents: claude, codex, gemini, pi (copilot and opencode share the
 * same dispatch path; three is sufficient for branch coverage).
 */
import { test, expect } from "bun:test";
import { validateTrajectory } from "../src/atif/validate.ts";

const CLI = new URL("../src/cli/normalize.ts", import.meta.url).pathname;

async function runCli(
  normalizerName: string,
  fixturePath: string,
  version = "test-version",
): Promise<{ code: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(
    ["bun", "run", CLI, normalizerName, fixturePath, "--version", version],
    { stdout: "pipe", stderr: "pipe" },
  );
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  const code = await proc.exited;
  return { code, stdout, stderr };
}

test("claude: exits 0 and emits valid ATIF", async () => {
  const fixture = new URL("./fixtures/claude-legacy-basic.jsonl", import.meta.url).pathname;
  const { code, stdout } = await runCli("claude", fixture, "2.1.175");
  expect(code).toBe(0);
  const traj = JSON.parse(stdout);
  expect(traj.schema_version).toBe("ATIF-v1.7");
  expect(traj.agent.name).toBe("claude-code");
  expect(validateTrajectory(traj).ok).toBe(true);
});

test("codex: exits 0 and emits valid ATIF", async () => {
  const fixture = new URL("./fixtures/codex-basic.jsonl", import.meta.url).pathname;
  const { code, stdout } = await runCli("codex", fixture, "1.0.0");
  expect(code).toBe(0);
  const traj = JSON.parse(stdout);
  expect(traj.schema_version).toBe("ATIF-v1.7");
  expect(traj.agent.name).toBe("codex");
  expect(validateTrajectory(traj).ok).toBe(true);
});

test("gemini: exits 0 and emits valid ATIF", async () => {
  const fixture = new URL("./fixtures/gemini-basic.jsonl", import.meta.url).pathname;
  const { code, stdout } = await runCli("gemini", fixture, "0.1.0");
  expect(code).toBe(0);
  const traj = JSON.parse(stdout);
  expect(traj.schema_version).toBe("ATIF-v1.7");
  expect(traj.agent.name).toBe("gemini");
  expect(validateTrajectory(traj).ok).toBe(true);
});

test("pi: exits 0 and emits valid ATIF", async () => {
  const fixture = new URL("./fixtures/pi-basic.jsonl", import.meta.url).pathname;
  const { code, stdout } = await runCli("pi", fixture, "3.0.0");
  expect(code).toBe(0);
  const traj = JSON.parse(stdout);
  expect(traj.schema_version).toBe("ATIF-v1.7");
  expect(traj.agent.name).toBe("pi");
  expect(validateTrajectory(traj).ok).toBe(true);
});

test("kimi: exits 0 and emits valid ATIF", async () => {
  const fixture = new URL("./fixtures/kimi-basic.jsonl", import.meta.url).pathname;
  const { code, stdout } = await runCli("kimi", fixture, "0.1.0");
  expect(code).toBe(0);
  const traj = JSON.parse(stdout);
  expect(traj.schema_version).toBe("ATIF-v1.7");
  expect(traj.agent.name).toBe("kimi");
  expect(validateTrajectory(traj).ok).toBe(true);
});

test("antigravity: exits 0 and emits valid ATIF", async () => {
  const fixture = new URL("./fixtures/antigravity-basic.jsonl", import.meta.url).pathname;
  const { code, stdout } = await runCli("antigravity", fixture, "0.1.0");
  expect(code).toBe(0);
  const traj = JSON.parse(stdout);
  expect(traj.schema_version).toBe("ATIF-v1.7");
  expect(traj.agent.name).toBe("antigravity");
  expect(validateTrajectory(traj).ok).toBe(true);
});

test("unknown normalizer: exits 2 with error on stderr", async () => {
  const fixture = new URL("./fixtures/claude-legacy-basic.jsonl", import.meta.url).pathname;
  const { code, stderr } = await runCli("nonexistent-agent", fixture);
  expect(code).toBe(2);
  expect(stderr).toContain("unknown normalizer");
});

test("missing args: exits 2 with usage on stderr", async () => {
  // Pass no path — just the normalizer name
  const proc = Bun.spawn(["bun", "run", CLI, "claude"], { stdout: "pipe", stderr: "pipe" });
  const stderr = await new Response(proc.stderr).text();
  const code = await proc.exited;
  expect(code).toBe(2);
  expect(stderr).toContain("usage:");
});
