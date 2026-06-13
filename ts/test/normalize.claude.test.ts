import { test, expect } from "bun:test";
import { normalizeClaudeLegacy } from "../src/normalize/claude.ts";
import { validateTrajectory } from "../src/atif/validate.ts";

const raw = await Bun.file(
  new URL("./fixtures/claude-legacy-basic.jsonl", import.meta.url),
).text();

test("produces a valid ATIF v1.7 trajectory", () => {
  const traj = normalizeClaudeLegacy(raw, "2.1.175");
  const r = validateTrajectory(traj);
  expect(r.errors).toEqual([]);
  expect(r.ok).toBe(true);
  expect(traj.schema_version).toBe("ATIF-v1.7");
  expect(traj.agent).toEqual({ name: "claude-code", version: "2.1.175" });
});

test("maps tool_use blocks to ATIF tool_calls", () => {
  const traj = normalizeClaudeLegacy(raw, "2.1.175");
  const calls = traj.steps.flatMap((s) => s.tool_calls ?? []);
  expect(calls.map((c) => c.function_name)).toEqual(["Write", "Bash"]);
  expect(calls[0]).toEqual({
    tool_call_id: "toolu_01",
    function_name: "Write",
    arguments: { file_path: "hello.txt", content: "hi" },
  });
});

test("captures thinking as reasoning_content and text as message", () => {
  const traj = normalizeClaudeLegacy(raw, "2.1.175");
  const writeStep = traj.steps.find((s) => s.tool_calls?.some((c) => c.tool_call_id === "toolu_01"))!;
  expect(writeStep.source).toBe("agent");
  expect(writeStep.reasoning_content).toBe("I'll write the file.");
  expect(writeStep.message).toBe("Writing the file now.");
});

test("attaches tool_result to the issuing step as an observation", () => {
  const traj = normalizeClaudeLegacy(raw, "2.1.175");
  const writeStep = traj.steps.find((s) => s.tool_calls?.some((c) => c.tool_call_id === "toolu_01"))!;
  expect(writeStep.observation?.results).toEqual([{ source_call_id: "toolu_01", content: "File created" }]);
});

test("emits a user step for the initial prompt and no step for pure tool_result lines", () => {
  const traj = normalizeClaudeLegacy(raw, "2.1.175");
  expect(traj.steps[0]).toMatchObject({ step_id: 1, source: "user", message: "create hello.txt with hi" });
  expect(traj.steps.length).toBe(3);
  expect(traj.steps.map((s) => s.source)).toEqual(["user", "agent", "agent"]);
});

test("step_ids are sequential from 1", () => {
  const traj = normalizeClaudeLegacy(raw, "2.1.175");
  expect(traj.steps.map((s) => s.step_id)).toEqual([1, 2, 3]);
});

test("tolerates blank and unparseable lines", () => {
  const traj = normalizeClaudeLegacy('\n{not json}\n{"type":"user","message":{"content":[{"type":"text","text":"hi"}]}}\n', "2.1.175");
  expect(traj.steps.length).toBe(1);
  expect(traj.steps[0]!.message).toBe("hi");
});

// --- string-content user message tests (2.1.177 real-format) ---

test("string-content user record becomes a user step", () => {
  const line = '{"type":"user","message":{"role":"user","content":"hello world"}}';
  const traj = normalizeClaudeLegacy(line, "2.1.177");
  expect(traj.steps.length).toBe(1);
  expect(traj.steps[0]!.source).toBe("user");
  expect(traj.steps[0]!.message).toBe("hello world");
});

test("real 2.1.177 fixture: user prompt captured, unknown types ignored", async () => {
  const raw = await Bun.file(
    new URL("./fixtures/claude-2.1.177-real.jsonl", import.meta.url),
  ).text();
  const traj = normalizeClaudeLegacy(raw, "2.1.177");
  const r = validateTrajectory(traj);
  expect(r.ok).toBe(true);
  const userStep = traj.steps.find((s) => s.source === "user" && s.message && s.message.length > 0);
  expect(userStep).toBeDefined();
  expect(userStep!.message).toBe("create a file hello.txt containing the word hi, then stop");
  expect(traj.steps.every((s) => s.source === "user" || s.source === "agent")).toBe(true);
});

// ---------------------------------------------------------------------------
// Fix 4: mixed text+tool_result user turns
// ---------------------------------------------------------------------------

test("mixed user turn: attaches tool_result observation AND emits user step", () => {
  // A user message containing both a tool_result and a text block.
  // Before the fix: the tool_result was discarded and only the user step was emitted.
  // After the fix: the observation is attached to the issuing agent step AND
  // a user step is emitted for the text.
  const raw = [
    // assistant step that issues toolu_01
    JSON.stringify({
      type: "assistant",
      message: {
        role: "assistant",
        content: [
          { type: "tool_use", id: "toolu_01", name: "Bash", input: { command: "ls" } },
        ],
      },
    }),
    // user turn with BOTH a tool_result and a text block (interrupted)
    JSON.stringify({
      type: "user",
      message: {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "toolu_01", content: "file.txt" },
          { type: "text", text: "[interrupted]" },
        ],
      },
    }),
  ].join("\n");

  const traj = normalizeClaudeLegacy(raw, "2.1.175");

  // The agent step should have the observation attached
  const agentStep = traj.steps.find((s) => s.source === "agent");
  expect(agentStep).toBeDefined();
  expect(agentStep!.observation?.results).toBeDefined();
  expect(agentStep!.observation!.results).toEqual([
    { source_call_id: "toolu_01", content: "file.txt" },
  ]);

  // A user step should also be emitted for the text
  const userStep = traj.steps.find((s) => s.source === "user");
  expect(userStep).toBeDefined();
  expect(userStep!.message).toBe("[interrupted]");

  // Total: agent step + user step
  expect(traj.steps.length).toBe(2);
});

test("CLI reads a session file and prints valid ATIF JSON", async () => {
  const fixture = new URL("./fixtures/claude-legacy-basic.jsonl", import.meta.url).pathname;
  const cli = new URL("../src/cli/normalize-claude.ts", import.meta.url).pathname;
  const proc = Bun.spawn(["bun", "run", cli, fixture, "--version", "2.1.175"]);
  const out = await new Response(proc.stdout).text();
  const code = await proc.exited;
  expect(code).toBe(0);
  const traj = JSON.parse(out);
  expect(traj.schema_version).toBe("ATIF-v1.7");
  expect(validateTrajectory(traj).ok).toBe(true);
});
