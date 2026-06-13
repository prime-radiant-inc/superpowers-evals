# ATIF Foundation + Claude→ATIF Normalizer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stand up the first TypeScript/bun code in the quorum repo: a zero-dependency ATIF v1.7 type + validation module, and a Claude-Code→ATIF normalizer for the legacy on-disk transcript layout, runnable standalone.

**Architecture:** Strangler-fig — the Python harness keeps working unchanged. We add an isolated `ts/` bun workspace that defines ATIF v1.7 as quorum's canonical transcript schema and converts one agent's on-disk logs into it. This is the foundation the later `check-transcript` tool (Plan 2) consumes, and it carries the durable fix path for B1 (Claude transcript capture).

**Tech Stack:** TypeScript, bun (runtime + built-in test runner). Zero runtime/test dependencies — hand-written interfaces + a small structural validator, matching prudence's bun-native, dep-light style.

---

## Scope

**In this plan (Plan 1 of 2):**
- A bun TS workspace under `ts/`.
- ATIF v1.7 core types + a structural validator (the canonical transcript contract).
- A Claude-Code→ATIF normalizer for the **legacy** `~/.claude/projects/<munged>/<uuid>.jsonl` layout — i.e. what the **pinned claude 2.1.175** produces and what `quorum/normalizers.py:normalize_claude_logs` already parses.
- A standalone CLI entry that converts a session file to an ATIF `trajectory.json`.

**Deferred (separate plans), with reasons:**
- **Claude 2.1.x (`sessions/…`) support / unpin.** B1's root cause is *not yet confirmed*: the real `~/.claude/sessions/<uuid>/history.jsonl` files observed are empty/stale, so we do not yet know where 2.1.177 writes the transcript in `-p` mode. Task 7 here is the **reproduction experiment** that establishes ground truth + a captured fixture; the 2.1.x parser is specced only after that lands. We do **not** write parser code against an unverified layout.
- **`check-transcript` bun tool + scenario caller migration (Plan 2).** Depends on ATIF being produced (this plan) and touches every scenario `checks.sh`; deserves dedicated parity scope against the existing 31 `bin/` tests.
- **Other agents' normalizers (codex/gemini/copilot/opencode/pi).** Same shape as claude; port after the claude pilot proves the pattern.

## File Structure

- Create: `ts/package.json` — bun workspace manifest (name `@quorum/ts`, `type: module`), no deps.
- Create: `ts/tsconfig.json` — strict TS config for bun.
- Create: `ts/.gitignore` — ignore `node_modules/`.
- Create: `ts/src/atif/types.ts` — ATIF v1.7 TypeScript interfaces (canonical schema).
- Create: `ts/src/atif/validate.ts` — `validateTrajectory()` structural validator.
- Create: `ts/src/normalize/claude.ts` — `normalizeClaudeLegacy(raw): AtifTrajectory`.
- Create: `ts/src/cli/normalize-claude.ts` — standalone CLI: file path → ATIF JSON on stdout.
- Create: `ts/test/atif.validate.test.ts` — validator tests.
- Create: `ts/test/normalize.claude.test.ts` — normalizer tests.
- Create: `ts/test/fixtures/claude-legacy-basic.jsonl` — faithful legacy CC session fixture.

Each file has one responsibility; tests live beside the module they exercise under `ts/test/`.

---

## Task 1: Bootstrap the bun TS workspace

**Files:**
- Create: `ts/package.json`
- Create: `ts/tsconfig.json`
- Create: `ts/.gitignore`
- Test: `ts/test/smoke.test.ts`

- [ ] **Step 1: Write the failing smoke test**

`ts/test/smoke.test.ts`:
```ts
import { test, expect } from "bun:test";

test("bun test runner is wired up", () => {
  expect(1 + 1).toBe(2);
});
```

- [ ] **Step 2: Run it to verify it fails (no workspace yet)**

Run: `cd ts && bun test test/smoke.test.ts`
Expected: FAIL — bun errors that there is no `package.json` / cannot resolve the workspace (or `bun: command not found` if bun is missing → install bun first: `curl -fsSL https://bun.sh/install | bash`).

- [ ] **Step 3: Create the workspace files**

`ts/package.json`:
```json
{
  "name": "@quorum/ts",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "scripts": {
    "test": "bun test",
    "typecheck": "tsc --noEmit"
  }
}
```

`ts/tsconfig.json`:
```json
{
  "compilerOptions": {
    "target": "ESNext",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "types": ["bun-types"],
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "allowImportingTsExtensions": true,
    "noEmit": true,
    "skipLibCheck": true
  },
  "include": ["src", "test"]
}
```

`ts/.gitignore`:
```
node_modules/
```

- [ ] **Step 4: Run the smoke test to verify it passes**

Run: `cd ts && bun test test/smoke.test.ts`
Expected: PASS (1 test).

- [ ] **Step 5: Commit**

```bash
git add ts/package.json ts/tsconfig.json ts/.gitignore ts/test/smoke.test.ts
git commit -m "feat(ts): bootstrap bun workspace for the TS migration pilot"
```

---

## Task 2: ATIF v1.7 types

**Files:**
- Create: `ts/src/atif/types.ts`

This task defines types only (no behavior to test directly); it is exercised by Tasks 3–6. Keep the interfaces faithful to ATIF v1.7 (`schema_version` literal pinned) and allow forward-compatible passthrough via `extra`.

- [ ] **Step 1: Write the types**

`ts/src/atif/types.ts`:
```ts
// ATIF v1.7 — Agent Trajectory Interchange Format (Harbor framework).
// Canonical transcript schema for quorum. We model the core fields quorum
// needs; training-only fields (token ids, logprobs) are intentionally omitted
// but survive round-trips via `extra`. Pin the version — ATIF has had breaking
// changes across minors.

export const ATIF_SCHEMA_VERSION = "ATIF-v1.7" as const;

export type AtifSource = "system" | "user" | "agent";

export interface AtifToolCall {
  tool_call_id: string;
  function_name: string;
  arguments: Record<string, unknown>;
  extra?: Record<string, unknown>;
}

export interface AtifObservationResult {
  source_call_id?: string;
  content?: string | unknown[] | null;
  extra?: Record<string, unknown>;
}

export interface AtifObservation {
  results: AtifObservationResult[];
}

export interface AtifMetrics {
  prompt_tokens?: number;
  completion_tokens?: number;
  cached_tokens?: number;
  cost_usd?: number;
  extra?: Record<string, unknown>;
}

export interface AtifStep {
  step_id: number;
  timestamp?: string;
  source: AtifSource;
  model_name?: string;
  message?: string | unknown[];
  reasoning_content?: string;
  tool_calls?: AtifToolCall[];
  observation?: AtifObservation;
  metrics?: AtifMetrics;
  extra?: Record<string, unknown>;
}

export interface AtifAgent {
  name: string;
  version: string;
  model_name?: string;
  extra?: Record<string, unknown>;
}

export interface AtifFinalMetrics {
  total_prompt_tokens?: number;
  total_completion_tokens?: number;
  total_cost_usd?: number;
  total_steps?: number;
  extra?: Record<string, unknown>;
}

export interface AtifTrajectory {
  schema_version: typeof ATIF_SCHEMA_VERSION;
  session_id?: string;
  trajectory_id?: string;
  agent: AtifAgent;
  steps: AtifStep[];
  final_metrics?: AtifFinalMetrics;
  subagent_trajectories?: AtifTrajectory[];
  extra?: Record<string, unknown>;
}
```

- [ ] **Step 2: Typecheck**

Run: `cd ts && bun run typecheck`
Expected: PASS (no errors). If `tsc` is unavailable, run `bunx tsc --noEmit`.

- [ ] **Step 3: Commit**

```bash
git add ts/src/atif/types.ts
git commit -m "feat(ts): add ATIF v1.7 transcript types"
```

---

## Task 3: ATIF structural validator

**Files:**
- Create: `ts/src/atif/validate.ts`
- Test: `ts/test/atif.validate.test.ts`

Enforce the invariants ATIF itself enforces (from the v1.7 Pydantic models): pinned `schema_version`; `agent.name`/`agent.version` present; `steps` non-empty; `step_id` sequential from 1; agent-only fields (`tool_calls`, `reasoning_content`, `model_name`, `metrics`) only on agent steps; each `observation.results[].source_call_id` (when set) must reference a `tool_call_id` in the **same** step.

- [ ] **Step 1: Write the failing tests**

`ts/test/atif.validate.test.ts`:
```ts
import { test, expect } from "bun:test";
import { validateTrajectory } from "../src/atif/validate.ts";
import type { AtifTrajectory } from "../src/atif/types.ts";

function good(): AtifTrajectory {
  return {
    schema_version: "ATIF-v1.7",
    agent: { name: "claude-code", version: "2.1.175" },
    steps: [
      { step_id: 1, source: "user", message: "do a thing" },
      {
        step_id: 2,
        source: "agent",
        tool_calls: [{ tool_call_id: "t1", function_name: "Bash", arguments: { command: "ls" } }],
        observation: { results: [{ source_call_id: "t1", content: "file.txt" }] },
      },
    ],
  };
}

test("accepts a well-formed trajectory", () => {
  const r = validateTrajectory(good());
  expect(r.ok).toBe(true);
  expect(r.errors).toEqual([]);
});

test("rejects a wrong schema_version", () => {
  const t = good();
  (t as { schema_version: string }).schema_version = "ATIF-v1.6";
  const r = validateTrajectory(t);
  expect(r.ok).toBe(false);
  expect(r.errors.some((e) => e.includes("schema_version"))).toBe(true);
});

test("rejects empty steps", () => {
  const t = good();
  t.steps = [];
  expect(validateTrajectory(t).ok).toBe(false);
});

test("rejects non-sequential step_id", () => {
  const t = good();
  t.steps[1]!.step_id = 5;
  const r = validateTrajectory(t);
  expect(r.ok).toBe(false);
  expect(r.errors.some((e) => e.includes("step_id"))).toBe(true);
});

test("rejects tool_calls on a non-agent step", () => {
  const t = good();
  t.steps[0]!.tool_calls = [{ tool_call_id: "x", function_name: "Bash", arguments: {} }];
  const r = validateTrajectory(t);
  expect(r.ok).toBe(false);
  expect(r.errors.some((e) => e.includes("agent-only"))).toBe(true);
});

test("rejects an observation referencing a tool_call from another step", () => {
  const t = good();
  t.steps[1]!.observation = { results: [{ source_call_id: "does-not-exist", content: "x" }] };
  const r = validateTrajectory(t);
  expect(r.ok).toBe(false);
  expect(r.errors.some((e) => e.includes("source_call_id"))).toBe(true);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd ts && bun test test/atif.validate.test.ts`
Expected: FAIL — `Cannot find module '../src/atif/validate.ts'`.

- [ ] **Step 3: Implement the validator**

`ts/src/atif/validate.ts`:
```ts
import { ATIF_SCHEMA_VERSION, type AtifTrajectory, type AtifStep } from "./types.ts";

export interface ValidationResult {
  ok: boolean;
  errors: string[];
}

const AGENT_ONLY: (keyof AtifStep)[] = ["tool_calls", "reasoning_content", "model_name", "metrics"];

export function validateTrajectory(t: AtifTrajectory): ValidationResult {
  const errors: string[] = [];

  if (t.schema_version !== ATIF_SCHEMA_VERSION) {
    errors.push(`schema_version must be ${ATIF_SCHEMA_VERSION}, got ${String(t.schema_version)}`);
  }
  if (!t.agent || !t.agent.name || !t.agent.version) {
    errors.push("agent.name and agent.version are required");
  }
  if (!Array.isArray(t.steps) || t.steps.length < 1) {
    errors.push("steps must be a non-empty array");
    return { ok: errors.length === 0, errors };
  }

  t.steps.forEach((step, i) => {
    const expectedId = i + 1;
    if (step.step_id !== expectedId) {
      errors.push(`step[${i}].step_id must be ${expectedId} (sequential from 1), got ${step.step_id}`);
    }
    if (!["system", "user", "agent"].includes(step.source)) {
      errors.push(`step[${i}].source invalid: ${String(step.source)}`);
    }
    if (step.source !== "agent") {
      for (const field of AGENT_ONLY) {
        if (step[field] !== undefined) {
          errors.push(`step[${i}] has agent-only field "${field}" on a ${step.source} step`);
        }
      }
    }
    const callIds = new Set((step.tool_calls ?? []).map((c) => c.tool_call_id));
    for (const result of step.observation?.results ?? []) {
      if (result.source_call_id !== undefined && !callIds.has(result.source_call_id)) {
        errors.push(
          `step[${i}] observation source_call_id "${result.source_call_id}" does not match a tool_call in the same step`,
        );
      }
    }
  });

  return { ok: errors.length === 0, errors };
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd ts && bun test test/atif.validate.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add ts/src/atif/validate.ts ts/test/atif.validate.test.ts
git commit -m "feat(ts): add ATIF structural validator"
```

---

## Task 4: Legacy Claude session fixture

**Files:**
- Create: `ts/test/fixtures/claude-legacy-basic.jsonl`

A faithful legacy Claude-Code session log. Shape is the standard Anthropic content-block format that `quorum/normalizers.py:normalize_claude_logs` (lines 228–258) parses: assistant messages carry `message.content[]` with `text` / `thinking` / `tool_use` blocks; user messages carry `text` and/or `tool_result` blocks (`tool_result.tool_use_id` references the `tool_use.id`).

- [ ] **Step 1: Create the fixture**

`ts/test/fixtures/claude-legacy-basic.jsonl`:
```jsonl
{"type":"user","message":{"role":"user","content":[{"type":"text","text":"create hello.txt with hi"}]}}
{"type":"assistant","message":{"role":"assistant","content":[{"type":"thinking","thinking":"I'll write the file."},{"type":"text","text":"Writing the file now."},{"type":"tool_use","id":"toolu_01","name":"Write","input":{"file_path":"hello.txt","content":"hi"}}]}}
{"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"toolu_01","content":"File created"}]}}
{"type":"assistant","message":{"role":"assistant","content":[{"type":"tool_use","id":"toolu_02","name":"Bash","input":{"command":"cat hello.txt"}}]}}
{"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"toolu_02","content":"hi"}]}}
```

- [ ] **Step 2: Commit**

```bash
git add ts/test/fixtures/claude-legacy-basic.jsonl
git commit -m "test(ts): add legacy claude session fixture"
```

---

## Task 5: Claude legacy → ATIF normalizer

**Files:**
- Create: `ts/src/normalize/claude.ts`
- Test: `ts/test/normalize.claude.test.ts`

Mapping rules (faithful to the legacy format and ATIF v1.7):
- Walk the JSONL line by line, building `steps` with `step_id` from 1.
- An `assistant` line → an **agent** step: `text` blocks joined into `message`; `thinking` blocks joined into `reasoning_content`; each `tool_use` block → an `AtifToolCall { tool_call_id: block.id, function_name: block.name, arguments: block.input }`.
- A `user` line whose blocks are **only `tool_result`** → attach each as an `AtifObservationResult { source_call_id: tool_use_id, content }` onto the **agent step that issued the matching `tool_use`** (keeps `source_call_id` in the same step, per the validator). Do not emit a separate step.
- A `user` line with `text` blocks → a **user** step with `message`.
- Skip empty/unparseable lines (match the Python normalizer's leniency).
- The returned trajectory pins `schema_version` and sets `agent = { name: "claude-code", version }` (version passed in by the caller; the CLI defaults it).

- [ ] **Step 1: Write the failing tests**

`ts/test/normalize.claude.test.ts`:
```ts
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
  // 1 user prompt + 2 agent steps = 3 steps (the two tool_result lines fold into agent steps)
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
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd ts && bun test test/normalize.claude.test.ts`
Expected: FAIL — `Cannot find module '../src/normalize/claude.ts'`.

- [ ] **Step 3: Implement the normalizer**

`ts/src/normalize/claude.ts`:
```ts
import {
  ATIF_SCHEMA_VERSION,
  type AtifTrajectory,
  type AtifStep,
  type AtifToolCall,
  type AtifObservationResult,
} from "../atif/types.ts";

interface Block {
  type?: string;
  text?: string;
  thinking?: string;
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
  tool_use_id?: string;
  content?: unknown;
}

function blocksOf(entry: Record<string, unknown>): Block[] {
  const message = entry["message"];
  if (message && typeof message === "object" && Array.isArray((message as { content?: unknown }).content)) {
    return (message as { content: Block[] }).content;
  }
  return [];
}

/**
 * Convert a legacy Claude-Code session log (the `~/.claude/projects/.../*.jsonl`
 * layout, as produced by claude 2.1.175) into an ATIF v1.7 trajectory.
 */
export function normalizeClaudeLegacy(raw: string, version: string): AtifTrajectory {
  const steps: AtifStep[] = [];
  const callIndex = new Map<string, AtifStep>(); // tool_use id -> issuing agent step

  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    let entry: Record<string, unknown>;
    try {
      entry = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    const type = entry["type"];
    const blocks = blocksOf(entry);

    if (type === "assistant") {
      const texts: string[] = [];
      const thinking: string[] = [];
      const toolCalls: AtifToolCall[] = [];
      for (const b of blocks) {
        if (b.type === "text" && typeof b.text === "string") texts.push(b.text);
        else if (b.type === "thinking" && typeof b.thinking === "string") thinking.push(b.thinking);
        else if (b.type === "tool_use") {
          toolCalls.push({
            tool_call_id: b.id ?? "",
            function_name: b.name ?? "",
            arguments: b.input ?? {},
          });
        }
      }
      const step: AtifStep = { step_id: steps.length + 1, source: "agent" };
      if (texts.length) step.message = texts.join("\n");
      if (thinking.length) step.reasoning_content = thinking.join("\n");
      if (toolCalls.length) {
        step.tool_calls = toolCalls;
        for (const c of toolCalls) callIndex.set(c.tool_call_id, step);
      }
      steps.push(step);
      continue;
    }

    if (type === "user") {
      const results: AtifObservationResult[] = [];
      const texts: string[] = [];
      for (const b of blocks) {
        if (b.type === "tool_result") {
          results.push({ source_call_id: b.tool_use_id, content: b.content as AtifObservationResult["content"] });
        } else if (b.type === "text" && typeof b.text === "string") {
          texts.push(b.text);
        }
      }
      // Pure tool_result line: fold into the issuing agent step(s).
      if (results.length && !texts.length) {
        for (const r of results) {
          const owner = r.source_call_id ? callIndex.get(r.source_call_id) : undefined;
          if (owner) {
            (owner.observation ??= { results: [] }).results.push(r);
          }
        }
        continue;
      }
      if (texts.length) {
        steps.push({ step_id: steps.length + 1, source: "user", message: texts.join("\n") });
      }
    }
  }

  return {
    schema_version: ATIF_SCHEMA_VERSION,
    agent: { name: "claude-code", version },
    steps,
  };
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd ts && bun test test/normalize.claude.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 5: Run the full TS suite + typecheck**

Run: `cd ts && bun test && bun run typecheck`
Expected: all tests PASS, typecheck clean.

- [ ] **Step 6: Commit**

```bash
git add ts/src/normalize/claude.ts ts/test/normalize.claude.test.ts
git commit -m "feat(ts): add legacy claude->ATIF normalizer"
```

---

## Task 6: Standalone CLI entry

**Files:**
- Create: `ts/src/cli/normalize-claude.ts`
- Test: `ts/test/normalize.claude.test.ts` (append a CLI test)

- [ ] **Step 1: Write the failing CLI test**

Append to `ts/test/normalize.claude.test.ts`:
```ts
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
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd ts && bun test test/normalize.claude.test.ts -t "CLI reads"`
Expected: FAIL — CLI module missing (nonzero exit / empty stdout).

- [ ] **Step 3: Implement the CLI**

`ts/src/cli/normalize-claude.ts`:
```ts
import { normalizeClaudeLegacy } from "../normalize/claude.ts";

function arg(flag: string, fallback: string): string {
  const i = Bun.argv.indexOf(flag);
  return i >= 0 && Bun.argv[i + 1] ? Bun.argv[i + 1]! : fallback;
}

const path = Bun.argv[2];
if (!path || path.startsWith("--")) {
  console.error("usage: bun run normalize-claude.ts <session.jsonl> [--version <v>]");
  process.exit(2);
}

const raw = await Bun.file(path).text();
const traj = normalizeClaudeLegacy(raw, arg("--version", "unknown"));
console.log(JSON.stringify(traj, null, 2));
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd ts && bun test test/normalize.claude.test.ts -t "CLI reads"`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add ts/src/cli/normalize-claude.ts ts/test/normalize.claude.test.ts
git commit -m "feat(ts): add standalone claude->ATIF CLI"
```

---

## Task 7: Confirm where Claude 2.1.x writes its transcript (reproduction experiment)

**This task produces a documented finding + a real captured fixture — not parser code.** B1's root cause is unconfirmed; the `sessions/<uuid>/history.jsonl` files observed so far were empty. We must establish ground truth before writing a 2.1.x normalizer. The 2.1.x parser + unpin become a follow-up plan authored from this task's output.

**Files:**
- Create: `docs/audits/2026-06-13-claude-2.1.x-transcript-location.md` (findings)
- Create (if a transcript is produced): `ts/test/fixtures/claude-2.1.x-<layout>.jsonl` (sanitized real fixture)

- [ ] **Step 1: Snapshot, then run claude 2.1.177 the way quorum does, in an isolated config dir**

```bash
TMP=$(mktemp -d); CFG="$TMP/cfg"; WD="$TMP/wd"; mkdir -p "$CFG" "$WD"
set -a; source /Users/jesse/git/prime-radiant-inc/serf/.env; set +a
( cd "$WD" && CLAUDE_CONFIG_DIR="$CFG" claude -p "write a file hello.txt containing hi" >/dev/null 2>&1 )
echo "=== every file written under the isolated config dir ==="
find "$CFG" -type f -printf '%s\t%p\n'
```
Expected: a list of files. Identify any containing the conversation transcript (JSONL with `tool_use`/`message` records). Record the exact relative path and whether it is non-empty.

- [ ] **Step 2: If nothing transcript-like appears under the isolated dir, check the real home and check print-mode flags**

```bash
ls -lt ~/.claude/sessions/*/ ~/.claude/projects/*/ 2>/dev/null | head
claude --help 2>&1 | grep -iE 'session|transcript|output|resume|print' || true
```
Expected: determine whether 2.1.177 `-p` persists a transcript at all, and if so where. Note findings verbatim.

- [ ] **Step 3: Record the finding**

Write `docs/audits/2026-06-13-claude-2.1.x-transcript-location.md` with: the exact transcript path (or "print mode does not persist"), the file's record shape (first record's keys), and the implication for the normalizer / for unpinning from 2.1.175. Update B1 in `docs/audits/2026-06-13-liveness-and-bitrot-audit.md` with the confirmed root cause.

- [ ] **Step 4: Capture a sanitized fixture if a transcript exists**

If a real transcript file was found, copy a small sanitized excerpt to `ts/test/fixtures/claude-2.1.x-<layout>.jsonl` for the follow-up normalizer plan.

- [ ] **Step 5: Commit**

```bash
git add docs/audits/2026-06-13-claude-2.1.x-transcript-location.md docs/audits/2026-06-13-liveness-and-bitrot-audit.md ts/test/fixtures/ 2>/dev/null
git commit -m "docs: confirm claude 2.1.x transcript location (B1 root cause)"
```

---

## Self-Review

**Spec coverage:**
- ATIF as canonical schema → Task 2 (types), Task 3 (validator). ✓
- Generated/derived TS types from the Pydantic schema → Task 2 (hand-derived, pinned v1.7). ✓
- Claude→ATIF normalizer (legacy/pinned) → Tasks 4–6. ✓
- B1 durable fix → correctly **gated** on Task 7's reproduction (not fabricated). ✓
- bun runtime, zero-dep → Task 1. ✓
- `check-transcript` tool + caller migration → explicitly deferred to Plan 2 (Scope). ✓ (Not in this plan by design.)

**Placeholder scan:** No TBDs. Task 7 is an investigation task with concrete runnable commands whose output is a doc + fixture — not a code placeholder; the parser it informs is a separate plan, stated as such.

**Type consistency:** `AtifTrajectory`/`AtifStep`/`AtifToolCall`/`AtifObservationResult` and `ATIF_SCHEMA_VERSION` are defined in Task 2 and used identically in Tasks 3, 5, 6. `normalizeClaudeLegacy(raw, version)` and `validateTrajectory(t)` signatures match across their tests and call sites. Fixture path `ts/test/fixtures/claude-legacy-basic.jsonl` is created in Task 4 and consumed in Tasks 5–6.

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-06-13-atif-foundation-and-claude-normalizer.md`.
