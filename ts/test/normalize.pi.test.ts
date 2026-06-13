import { test, expect } from "bun:test";
import { normalizePi } from "../src/normalize/pi.ts";
import { validateTrajectory } from "../src/atif/validate.ts";

// ---------------------------------------------------------------------------
// Fixtures — derived from quorum/normalizers.py and tests/quorum/test_normalizers.py
// ---------------------------------------------------------------------------

function makeMessage(content: unknown[]): string {
  return JSON.stringify({
    type: "message",
    message: { role: "assistant", content },
  });
}

const sessionHeader = JSON.stringify({ type: "session", cwd: "/tmp/project" });

const basicLines = [
  sessionHeader,
  makeMessage([
    { type: "text", text: "I will inspect this." },
    { type: "toolCall", name: "read", arguments: { path: "README.md" } },
    { type: "toolCall", name: "bash", arguments: { command: "git status" } },
    { type: "toolCall", name: "subagent", arguments: { agent: "reviewer" } },
  ]),
].join("\n");

// Comprehensive tool mapping test (derived from test_normalizes_live_style_pi_session)
const allToolsLines = [
  JSON.stringify({ type: "session", version: 3, id: "session-1", cwd: "/tmp/project" }),
  JSON.stringify({ type: "model_change", provider: "openai-codex", modelId: "gpt-5.5" }),
  makeMessage([
    { type: "toolCall", id: "call-read", name: "read", arguments: { path: "README.md" } },
  ]),
  makeMessage([
    { type: "toolCall", id: "call-write", name: "write", arguments: { path: "out.md", content: "ok" } },
    { type: "toolCall", id: "call-edit", name: "edit", arguments: { path: "out.md", oldString: "ok", newString: "done" } },
    { type: "toolCall", id: "call-bash", name: "bash", arguments: { command: "git status --short" } },
    { type: "toolCall", id: "call-find", name: "find", arguments: { path: ".", pattern: "*.md" } },
    { type: "toolCall", id: "call-ls", name: "ls", arguments: { path: "." } },
    { type: "toolCall", id: "call-custom", name: "custom_tool", arguments: { x: 1 } },
  ]),
  // tool_result row — should be ignored (role is toolResult, not assistant)
  JSON.stringify({
    type: "message",
    message: { role: "toolResult", toolCallId: "call-read", content: [{ type: "text", text: "README" }] },
  }),
  makeMessage([{ type: "text", text: "done" }]),
].join("\n");

// subagent aliasing test
function makeSubagentLine(args: Record<string, unknown>): string {
  return makeMessage([{ type: "toolCall", name: "subagent", arguments: args }]);
}

const subagentLines = [
  sessionHeader,
  makeSubagentLine({ agent: "reviewer", task: "review the diff" }),           // execution → Agent
  makeSubagentLine({ chain: [{ agent: "scout" }, { agent: "planner" }] }),    // execution → Agent
  makeSubagentLine({ tasks: [{ agent: "reviewer", count: 3 }], concurrency: 3 }), // execution → Agent
  makeSubagentLine({ action: "list" }),                                         // management → subagent
  makeSubagentLine({ action: "status", id: "run-1" }),                         // management → subagent
].join("\n");

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test("produces a valid ATIF v1.7 trajectory", () => {
  const traj = normalizePi(basicLines, "0.3.0");
  const r = validateTrajectory(traj);
  expect(r.errors).toEqual([]);
  expect(r.ok).toBe(true);
  expect(traj.schema_version).toBe("ATIF-v1.7");
  expect(traj.agent).toEqual({ name: "pi", version: "0.3.0" });
});

test("read maps to Read", () => {
  const traj = normalizePi(basicLines, "0.3.0");
  const tc = traj.steps[0]!.tool_calls![0]!;
  expect(tc.function_name).toBe("Read");
  expect(tc.arguments["path"]).toBe("README.md");
});

test("bash maps to Bash", () => {
  const traj = normalizePi(basicLines, "0.3.0");
  const bashStep = traj.steps.find((s) => s.tool_calls?.[0]?.function_name === "Bash");
  expect(bashStep).toBeDefined();
  expect(bashStep!.tool_calls![0]!.arguments["command"]).toBe("git status");
});

test("subagent (execution, no action key) maps to Agent", () => {
  const traj = normalizePi(basicLines, "0.3.0");
  const agentStep = traj.steps.find((s) => s.tool_calls?.[0]?.function_name === "Agent");
  expect(agentStep).toBeDefined();
  expect(agentStep!.tool_calls![0]!.arguments["agent"]).toBe("reviewer");
});

test("all standard Pi tool names map correctly", () => {
  const traj = normalizePi(allToolsLines, "0.3.0");
  const r = validateTrajectory(traj);
  expect(r.ok).toBe(true);
  const names = traj.steps
    .filter((s) => s.source === "agent")
    .map((s) => s.tool_calls![0]!.function_name);
  expect(names).toEqual([
    "Read",
    "Write",
    "Edit",
    "Bash",
    "Glob",  // find
    "Glob",  // ls
    "custom_tool",
  ]);
});

test("find maps to Glob", () => {
  const traj = normalizePi(allToolsLines, "0.3.0");
  const findStep = traj.steps.find(
    (s) => s.tool_calls?.[0]?.function_name === "Glob" && "pattern" in (s.tool_calls[0]?.arguments ?? {}),
  );
  expect(findStep).toBeDefined();
  expect(findStep!.tool_calls![0]!.arguments["path"]).toBe(".");
  expect(findStep!.tool_calls![0]!.arguments["pattern"]).toBe("*.md");
});

test("ls maps to Glob", () => {
  const traj = normalizePi(allToolsLines, "0.3.0");
  const lsStep = traj.steps.find(
    (s) =>
      s.tool_calls?.[0]?.function_name === "Glob" &&
      !("pattern" in (s.tool_calls[0]?.arguments ?? {})),
  );
  expect(lsStep).toBeDefined();
  expect(lsStep!.tool_calls![0]!.arguments["path"]).toBe(".");
});

test("unknown tool names are preserved verbatim", () => {
  const traj = normalizePi(allToolsLines, "0.3.0");
  const customStep = traj.steps.find((s) => s.tool_calls?.[0]?.function_name === "custom_tool");
  expect(customStep).toBeDefined();
  expect(customStep!.tool_calls![0]!.arguments["x"]).toBe(1);
});

test("subagent execution calls alias to Agent, management calls stay subagent", () => {
  const traj = normalizePi(subagentLines, "0.3.0");
  const r = validateTrajectory(traj);
  expect(r.ok).toBe(true);
  const names = traj.steps
    .filter((s) => s.source === "agent")
    .map((s) => s.tool_calls![0]!.function_name);
  expect(names).toEqual(["Agent", "Agent", "Agent", "subagent", "subagent"]);
});

test("toolResult messages are ignored (only assistant role is processed)", () => {
  const traj = normalizePi(allToolsLines, "0.3.0");
  // allToolsLines has a toolResult row — it should not produce an agent step
  const toolResultSteps = traj.steps.filter(
    (s) => s.source === "agent" && s.tool_calls?.[0]?.function_name === undefined,
  );
  expect(toolResultSteps.length).toBe(0);
});

test("text-only assistant messages produce no agent step", () => {
  const lines = [sessionHeader, makeMessage([{ type: "text", text: "done" }])].join("\n");
  const traj = normalizePi(lines, "0.3.0");
  // No toolCall blocks → no agent steps
  const agentSteps = traj.steps.filter((s) => s.source === "agent");
  expect(agentSteps.length).toBe(0);
});

test("session and model_change rows are ignored", () => {
  const traj = normalizePi(allToolsLines, "0.3.0");
  // session and model_change rows should not produce steps
  expect(traj.steps.every((s) => s.source === "agent")).toBe(true);
});

test("tolerates blank lines and bad JSON", () => {
  const raw = `\n{not json}\n${makeMessage([{ type: "toolCall", name: "read", arguments: { path: "x" } }])}\n`;
  const traj = normalizePi(raw, "0.3.0");
  expect(validateTrajectory(traj).ok).toBe(true);
  expect(traj.steps[0]!.tool_calls![0]!.function_name).toBe("Read");
});

test("step_ids are sequential from 1", () => {
  const traj = normalizePi(basicLines, "0.3.0");
  const ids = traj.steps.map((s) => s.step_id);
  expect(ids).toEqual(ids.map((_, i) => i + 1));
});

test("tool_call_id is taken from block's id field when present", () => {
  const traj = normalizePi(allToolsLines, "0.3.0");
  const readStep = traj.steps.find((s) => s.tool_calls?.[0]?.function_name === "Read");
  expect(readStep!.tool_calls![0]!.tool_call_id).toBe("call-read");
});
