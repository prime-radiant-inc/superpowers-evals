# Quorum TS — Spec 1: Foundation + Walking Skeleton — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the thinnest end-to-end slice of the TypeScript rewrite — `quorum run <scenario> --coding-agent claude` and `quorum show` — that produces a semantically-identical `verdict.json` to the Python, proven against a **mock-gauntlet** (zero tokens) and a claude **replay-differential** test.

**Architecture:** A thin runner orchestrates discrete phases (setup → pre-checks → drive gauntlet → capture → post-checks → compose → write `verdict.json`). The hard QA work stays in external processes (`gauntlet`, the agent CLI, `obol`); this slice ports the orchestration, capture/normalization (claude only), obol pricing, three-valued verdict composition, and the `run`/`show` CLI. Every seam is exercised by a stub `gauntlet` that drops canned artifacts into the expected paths.

**Tech Stack:** Bun (primary, Node-compatible where free), TypeScript (strict), `zod` (boundary validation), `@primeradianthq/obol` (pricing), `commander` (CLI), `yaml` (config), Biome (lint/format), `bun test` (TDD), `bun build --compile` (single binary). Reused untouched: `bin/` bash check tools, `scenarios/`, `coding-agents/*.yaml`. `gauntlet` is a pure external subprocess.

**Parity rule:** behavior matches the Python (`quorum/*.py`) except where an approved spec supersedes it. None of the Spec-1 surface is superseded, so this slice is straight parity. Spec: `docs/superpowers/specs/2026-06-12-quorum-typescript-rewrite-design.md`. Ticket: PRI-2207.

**Coding standard (MANDATORY):** all TypeScript follows `docs/superpowers/specs/2026-06-12-typescript-coding-standard.md`. The gate is `bun run check` (Biome 2.x `ci` + `tsc --noEmit` + scoped `bun test`) and must be green per task. Non-negotiables: the single `src/env.ts` for **all** `process.env` access (use `getEnv`/`envSnapshot`/`superpowersRoot`); named exports + `import type`; **no** `any`/`as any`/`as never`/`!` in `src/`; `undefined` internally, `null` only where the on-disk JSON says so; `assertNever` on closed-union switches; `readonly` on boundary types; test fixtures zod-typed (never `as never`). The Task-1 `package.json`/`tsconfig.json`/`biome.json` blocks below are **superseded** by the adopted versions committed in `d44f3ff` (plus `bunfig.toml`, `src/env.ts`, `src/invariant.ts`); treat the standard + that commit as authoritative where they differ from a code block here.

**Reference (Python source of truth):** `quorum/runner.py`, `quorum/capture.py`, `quorum/normalizers.py` (claude), `quorum/obol_capture.py`, `quorum/economics.py`, `quorum/checks.py`, `quorum/composer.py`, `quorum/cli.py`, `quorum/show.py`, `quorum/setup_step.py`, `quorum/story_meta.py`, `quorum/coding_agent_config.py`.

---

## File Structure

```
package.json            bun project, deps, scripts, bin -> quorum
tsconfig.json           strict TS, ESM, bundler resolution
biome.json              lint + format config
.gitignore              add node_modules, dist, *.tsbuildinfo
src/
  contracts/
    verdict.ts          FinalVerdict, GauntletLayer, RunError, CheckRecord, ToolCall types + zod
    gauntlet.ts         GauntletResultJson zod schema (gauntlet's result.json)
    agent-config.ts     AgentConfig type + zod, loadAgentConfig(), env substitution
    economics.ts        TokenUsage + Economics types + zod
  obol/
    index.ts            estimateSessionLogs, estimateUsageSidecar, mergeEstimates, DIALECTS
  economics.ts          buildRunEconomics(runDir)
  normalizers/
    claude.ts           normalizeClaudeLogs, NATIVE_TOOLS
    index.ts            NORMALIZERS registry
  capture/
    index.ts            snapshotDir, newFilesSince, captureToolCalls, captureTokenUsage
  checks/
    index.ts            runPhase, parseCodingAgentsDirective
  composer.ts           compose() -> FinalVerdict (6-case tree)
  story-meta.ts         readQuorumMaxTime, readQuorumTier, readStoryStatus
  setup-step.ts         runSetup(scenarioDir, workdir, envExtra)
  agents/
    index.ts            CodingAgent interface, DefaultAgent, ClaudeAgent, resolveAgent
  runner/
    index.ts            runScenario, allocateRunDir, invokeGauntlet, phase orchestration
  cli/
    index.ts            commander program: run, show
    render.ts           render(verdict, runDir, {color, mode})
  paths.ts              small helpers: superpowersRoot(), nowStampUtc(), hexNonce()
test/
  mock-gauntlet/
    mock-gauntlet.ts    stub gauntlet binary: drops result.json + usage.jsonl + session log
    fixtures/
      pass/  result.json, usage.jsonl, claude-session.jsonl
      fail-no-usage/    result.json
      investigate/      result.json
  fixtures/
    claude/             real claude session .jsonl mined from results/ (for replay)
  golden/
    <scenario-run>/     frozen Python verdict.json (differential oracle)
  *.test.ts             one test file per module
```

**Boundaries:** `contracts/` is the shared type spine — every other module imports its types from there. `obol/` and `economics.ts` are pure given inputs. `runner/` is the only module that spawns `gauntlet` and writes `verdict.json`. `cli/` is a thin shell over `runner` + `render`.

---

## Task 1: Project skeleton & tooling

**Files:**
- Create: `package.json`, `tsconfig.json`, `biome.json`, `src/paths.ts`, `test/paths.test.ts`
- Modify: `.gitignore`

- [ ] **Step 1: Write `package.json`**

```json
{
  "name": "quorum",
  "version": "0.1.0",
  "type": "module",
  "bin": { "quorum": "./src/cli/index.ts" },
  "scripts": {
    "quorum": "bun run src/cli/index.ts",
    "test": "bun test",
    "typecheck": "tsc --noEmit",
    "lint": "biome check .",
    "format": "biome format --write .",
    "build": "bun build src/cli/index.ts --compile --outfile dist/quorum"
  },
  "dependencies": {
    "@primeradianthq/obol": "*",
    "commander": "^12",
    "yaml": "^2",
    "zod": "^3"
  },
  "devDependencies": {
    "@biomejs/biome": "^1.9",
    "@types/bun": "latest",
    "typescript": "^5.9"
  }
}
```

- [ ] **Step 2: Write `tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ESNext",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "allowImportingTsExtensions": true,
    "types": ["bun-types"],
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "verbatimModuleSyntax": true,
    "skipLibCheck": true,
    "noEmit": true
  },
  "include": ["src", "test"]
}
```

- [ ] **Step 3: Write `biome.json`**

```json
{
  "$schema": "https://biomejs.dev/schemas/1.9.4/schema.json",
  "files": { "ignore": ["dist", "results", "node_modules", "bin", "scenarios"] },
  "linter": { "enabled": true, "rules": { "recommended": true } },
  "formatter": { "enabled": true, "indentStyle": "space", "indentWidth": 2, "lineWidth": 100 }
}
```

- [ ] **Step 4: Append to `.gitignore`**

```
node_modules/
dist/
*.tsbuildinfo
```

- [ ] **Step 5: Install deps**

Run: `bun install`
Expected: lockfile written, `@primeradianthq/obol` + `commander` + `yaml` + `zod` resolved.

- [ ] **Step 6: Write the failing test for `src/paths.ts`**

```ts
// test/paths.test.ts
import { expect, test } from "bun:test";
import { hexNonce, nowStampUtc } from "../src/paths.ts";

test("nowStampUtc formats as YYYYMMDDTHHMMSSZ", () => {
  const stamp = nowStampUtc(new Date("2026-06-12T01:53:01.000Z"));
  expect(stamp).toBe("20260612T015301Z");
});

test("hexNonce is 4 lowercase hex chars", () => {
  expect(hexNonce()).toMatch(/^[0-9a-f]{4}$/);
});
```

- [ ] **Step 7: Run it to verify failure**

Run: `bun test test/paths.test.ts`
Expected: FAIL — cannot find module `../src/paths.ts`.

- [ ] **Step 8: Implement `src/paths.ts`**

```ts
// src/paths.ts
import { randomBytes } from "node:crypto";

/** UTC stamp matching Python's strftime("%Y%m%dT%H%M%SZ"). */
export function nowStampUtc(now: Date = new Date()): string {
  const p = (n: number, w = 2) => String(n).padStart(w, "0");
  return (
    `${now.getUTCFullYear()}${p(now.getUTCMonth() + 1)}${p(now.getUTCDate())}` +
    `T${p(now.getUTCHours())}${p(now.getUTCMinutes())}${p(now.getUTCSeconds())}Z`
  );
}

/** 4 hex chars == Python secrets.token_hex(2). */
export function hexNonce(): string {
  return randomBytes(2).toString("hex");
}

/** SUPERPOWERS_ROOT, required for live runs; throws if unset. */
export function superpowersRoot(env: NodeJS.ProcessEnv = process.env): string {
  const root = env.SUPERPOWERS_ROOT;
  if (!root) throw new Error("SUPERPOWERS_ROOT is not set");
  return root;
}
```

- [ ] **Step 9: Run tests to verify pass**

Run: `bun test test/paths.test.ts && bun run typecheck`
Expected: PASS (2 tests), typecheck clean.

- [ ] **Step 10: Commit**

```bash
git add package.json tsconfig.json biome.json .gitignore bun.lock src/paths.ts test/paths.test.ts
git commit -m "feat(quorum-ts): project skeleton + path helpers (PRI-2207)"
```

---

## Task 2: Core contracts & zod schemas (the spine)

**Files:**
- Create: `src/contracts/verdict.ts`, `src/contracts/gauntlet.ts`, `src/contracts/economics.ts`
- Test: `test/contracts.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// test/contracts.test.ts
import { expect, test } from "bun:test";
import { FinalVerdictSchema, type FinalVerdict } from "../src/contracts/verdict.ts";
import { GauntletResultSchema } from "../src/contracts/gauntlet.ts";

test("a real verdict.json parses and round-trips", () => {
  const v: FinalVerdict = {
    schema: 1,
    final: "pass",
    final_reason: "Gauntlet-Agent passed; no deterministic checks",
    gauntlet: { status: "pass", summary: "s", reasoning: "r", run_id: "x_20260529T170857Z_32wy" },
    checks: [{ check: "git-repo", args: [], negated: false, passed: true, detail: null, phase: "pre" }],
    error: null,
    economics: null,
  };
  expect(FinalVerdictSchema.parse(v)).toEqual(v);
});

test("gauntlet result.json validates status + reads run-relevant fields", () => {
  const r = GauntletResultSchema.parse({
    schemaVersion: 5,
    runId: "x_20260529T170857Z_32wy",
    status: "fail",
    summary: "s",
    reasoning: "r",
    duration_ms: 1234,
    config: { model: "claude-sonnet-4-6", target: "claude", adapter: "tui" },
  });
  expect(r.status).toBe("fail");
  expect(r.config?.model).toBe("claude-sonnet-4-6");
});
```

- [ ] **Step 2: Run it to verify failure**

Run: `bun test test/contracts.test.ts`
Expected: FAIL — modules not found.

- [ ] **Step 3: Implement `src/contracts/verdict.ts`**

```ts
// src/contracts/verdict.ts
import { z } from "zod";

export const GAUNTLET_STATUSES = ["pass", "fail", "investigate", "errored"] as const;
export const FINAL_STATUSES = ["pass", "fail", "indeterminate"] as const;
export const RUN_ERROR_STAGES = [
  "setup", "gauntlet", "capture", "checks", "compose",
  "qa-agent-misconfigured", "stopped", "unknown",
] as const;
export const CHECK_PHASES = ["pre", "post"] as const;

export type GauntletStatus = (typeof GAUNTLET_STATUSES)[number];
export type FinalStatus = (typeof FINAL_STATUSES)[number];
export type RunErrorStage = (typeof RUN_ERROR_STAGES)[number];
export type CheckPhase = (typeof CHECK_PHASES)[number];

export const ToolCallSchema = z.object({
  tool: z.string(),
  args: z.record(z.unknown()),
  source: z.enum(["native", "shell"]),
});
export type ToolCall = z.infer<typeof ToolCallSchema>;

export const CheckRecordSchema = z.object({
  check: z.string(),
  args: z.array(z.string()),
  negated: z.boolean(),
  passed: z.boolean(),
  detail: z.string().nullable(),
  phase: z.enum(CHECK_PHASES),
});
export type CheckRecord = z.infer<typeof CheckRecordSchema>;

export const GauntletLayerSchema = z.object({
  status: z.enum(GAUNTLET_STATUSES),
  summary: z.string(),
  reasoning: z.string(),
  run_id: z.string().nullable(),
});
export type GauntletLayer = z.infer<typeof GauntletLayerSchema>;

export const RunErrorSchema = z.object({
  stage: z.enum(RUN_ERROR_STAGES),
  message: z.string(),
});
export type RunError = z.infer<typeof RunErrorSchema>;

// economics is structurally validated in contracts/economics.ts; here it is opaque.
export const FinalVerdictSchema = z.object({
  schema: z.literal(1),
  final: z.enum(FINAL_STATUSES),
  final_reason: z.string(),
  gauntlet: GauntletLayerSchema.nullable(),
  checks: z.array(CheckRecordSchema),
  error: RunErrorSchema.nullable(),
  economics: z.record(z.unknown()).nullable(),
});
export type FinalVerdict = z.infer<typeof FinalVerdictSchema>;
```

- [ ] **Step 4: Implement `src/contracts/gauntlet.ts`**

```ts
// src/contracts/gauntlet.ts
import { z } from "zod";
import { GAUNTLET_STATUSES } from "./verdict.ts";

/** Gauntlet writes result.json (schemaVersion 5). We read only the fields quorum needs;
 *  unknown fields are ignored (passthrough), so gauntlet can evolve without breaking us. */
export const GauntletResultSchema = z
  .object({
    schemaVersion: z.number().optional(),
    runId: z.string().optional(),
    status: z.enum(GAUNTLET_STATUSES),
    summary: z.string().default(""),
    reasoning: z.string().default(""),
    duration_ms: z.number().optional(),
    config: z.object({ model: z.string().optional() }).passthrough().optional(),
    usage: z.record(z.unknown()).optional(),
  })
  .passthrough();
export type GauntletResultJson = z.infer<typeof GauntletResultSchema>;
```

- [ ] **Step 5: Implement `src/contracts/economics.ts`**

```ts
// src/contracts/economics.ts
import { z } from "zod";

/** Shape of coding-agent-token-usage.json (minus duration_ms, added at capture time). */
export const PerModelUsageSchema = z.object({
  total_input: z.number(),
  total_cache_create: z.number(),
  total_cache_read: z.number(),
  total_output: z.number(),
  total_tokens: z.number(),
  provider: z.string(),
  est_cost_usd: z.number().nullable(),
});
export const TokenUsageSchema = z.object({
  total_input: z.number(),
  total_cache_create: z.number(),
  total_cache_read: z.number(),
  total_output: z.number(),
  total_tokens: z.number(),
  model: z.string().nullable(),
  models: z.record(PerModelUsageSchema),
  est_cost_usd: z.number().nullable(),
  unpriced_models: z.array(z.string()),
  approximations: z.array(z.object({ kind: z.string(), detail: z.string().nullable() })),
  pricing_as_of: z.string().nullable(),
  duration_ms: z.number().nullable().optional(),
  tool_result_total_bytes: z.number().optional(),
});
export type TokenUsage = z.infer<typeof TokenUsageSchema>;
```

- [ ] **Step 6: Run tests to verify pass**

Run: `bun test test/contracts.test.ts && bun run typecheck`
Expected: PASS (2 tests), typecheck clean.

- [ ] **Step 7: Commit**

```bash
git add src/contracts test/contracts.test.ts
git commit -m "feat(quorum-ts): core contracts + zod schemas (PRI-2207)"
```

---

## Task 3: Agent config loader (YAML → AgentConfig) + env substitution

**Reference:** `quorum/coding_agent_config.py`; `coding-agents/claude.yaml`.

**Files:**
- Create: `src/contracts/agent-config.ts`
- Test: `test/agent-config.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// test/agent-config.test.ts
import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadAgentConfig, substituteEnv } from "../src/contracts/agent-config.ts";

test("loads claude.yaml into a typed AgentConfig", () => {
  const dir = mkdtempSync(join(tmpdir(), "agents-"));
  writeFileSync(
    join(dir, "claude.yaml"),
    [
      "name: claude",
      "runtime_family: claude",
      "binary: claude",
      "agent_config_env: CLAUDE_CONFIG_DIR",
      'session_log_dir: "${CLAUDE_CONFIG_DIR}/projects"',
      'session_log_glob: "**/*.jsonl"',
      "normalizer: claude",
      "required_env:",
      "  - ANTHROPIC_API_KEY",
      "max_time: 10m",
      "model: opus",
    ].join("\n"),
  );
  const cfg = loadAgentConfig(dir, "claude");
  expect(cfg.name).toBe("claude");
  expect(cfg.required_env).toEqual(["ANTHROPIC_API_KEY"]);
  expect(cfg.session_log_glob).toBe("**/*.jsonl");
  expect(cfg.max_concurrency).toBeUndefined();
});

test("substituteEnv replaces ${VAR} from a provided map", () => {
  expect(substituteEnv("${CLAUDE_CONFIG_DIR}/projects", { CLAUDE_CONFIG_DIR: "/tmp/cfg" })).toBe(
    "/tmp/cfg/projects",
  );
});
```

- [ ] **Step 2: Run it to verify failure**

Run: `bun test test/agent-config.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/contracts/agent-config.ts`**

```ts
// src/contracts/agent-config.ts
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { z } from "zod";

export const AgentConfigSchema = z.object({
  name: z.string(),
  runtime_family: z.string().optional(),
  binary: z.string(),
  agent_config_env: z.string(),
  session_log_dir: z.string(),
  session_log_glob: z.string(),
  normalizer: z.string(),
  required_env: z.array(z.string()).default([]),
  max_time: z.string().optional(),
  project_prompt: z.string().optional(),
  model: z.string().optional(),
  // PRI-2203 scheduler keys (parsed now, consumed in Spec 4)
  max_concurrency: z.number().int().min(1).optional(),
  launch_spacing_seconds: z.number().min(0).optional(),
});
export type AgentConfig = z.infer<typeof AgentConfigSchema>;

export function loadAgentConfig(codingAgentsDir: string, name: string): AgentConfig {
  const path = join(codingAgentsDir, `${name}.yaml`);
  const raw = parseYaml(readFileSync(path, "utf8"));
  return AgentConfigSchema.parse(raw);
}

/** Replace ${VAR} occurrences from a map. Unknown vars are left intact (mirrors Python). */
export function substituteEnv(text: string, vars: Record<string, string>): string {
  return text.replace(/\$\{([A-Z0-9_]+)\}/g, (m, k: string) => (k in vars ? vars[k] : m));
}
```

- [ ] **Step 4: Run tests to verify pass**

Run: `bun test test/agent-config.test.ts && bun run typecheck`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/contracts/agent-config.ts test/agent-config.test.ts
git commit -m "feat(quorum-ts): agent-config YAML loader + env substitution (PRI-2207)"
```

---

## Task 4: Claude normalizer

**Reference:** `quorum/normalizers.py` (`normalize_claude_logs`, `NATIVE_TOOLS`). Output is `{tool, args, source}`; source is `native` iff `tool ∈ NATIVE_TOOLS`, else `shell`. Two input shapes: flat `{type:"tool_use", name, input}` and nested `{type:"assistant", message:{content:[{type:"tool_use", name, input}]}}`. Names are NOT remapped for claude.

**Files:**
- Create: `src/normalizers/claude.ts`, `src/normalizers/index.ts`
- Test: `test/normalizers-claude.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// test/normalizers-claude.test.ts
import { expect, test } from "bun:test";
import { normalizeClaudeLogs } from "../src/normalizers/claude.ts";

test("flat tool_use: Bash is shell, Read is native", () => {
  const raw = [
    JSON.stringify({ type: "tool_use", name: "Bash", input: { command: "git status" } }),
    JSON.stringify({ type: "tool_use", name: "Read", input: { file_path: "/x" } }),
    JSON.stringify({ type: "text", text: "ignored" }),
  ].join("\n");
  expect(normalizeClaudeLogs(raw)).toEqual([
    { tool: "Bash", args: { command: "git status" }, source: "shell" },
    { tool: "Read", args: { file_path: "/x" }, source: "native" },
  ]);
});

test("nested assistant message: multiple tool_use blocks captured in order", () => {
  const raw = JSON.stringify({
    type: "assistant",
    message: { content: [
      { type: "text", text: "hi" },
      { type: "tool_use", name: "Edit", input: { file_path: "/a" } },
      { type: "tool_use", name: "Bash", input: { command: "ls" } },
    ] },
  });
  expect(normalizeClaudeLogs(raw)).toEqual([
    { tool: "Edit", args: { file_path: "/a" }, source: "native" },
    { tool: "Bash", args: { command: "ls" }, source: "shell" },
  ]);
});

test("blank lines and malformed JSON are skipped", () => {
  const raw = ["", "not json", JSON.stringify({ type: "tool_use", name: "Glob", input: {} })].join("\n");
  expect(normalizeClaudeLogs(raw)).toEqual([{ tool: "Glob", args: {}, source: "native" }]);
});
```

- [ ] **Step 2: Run it to verify failure**

Run: `bun test test/normalizers-claude.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/normalizers/claude.ts`**

```ts
// src/normalizers/claude.ts
import type { ToolCall } from "../contracts/verdict.ts";

/** Tools the harness considers "native" (everything else is "shell"). Global set, matches Python. */
export const NATIVE_TOOLS: ReadonlySet<string> = new Set([
  "EnterWorktree", "ExitWorktree", "EnterPlanMode", "ExitPlanMode",
  "TaskCreate", "TaskUpdate", "TaskList", "TaskGet",
  "Skill", "Agent", "Read", "Write", "Edit", "Glob", "Grep",
]);

function toolUseToCall(name: string, input: unknown): ToolCall {
  return {
    tool: name,
    args: (input ?? {}) as Record<string, unknown>,
    source: NATIVE_TOOLS.has(name) ? "native" : "shell",
  };
}

export function normalizeClaudeLogs(raw: string): ToolCall[] {
  const out: ToolCall[] = [];
  for (const line of raw.trim().split("\n")) {
    if (!line.trim()) continue;
    let entry: Record<string, unknown>;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (entry.type === "assistant") {
      const content = (entry.message as { content?: unknown[] } | undefined)?.content ?? [];
      for (const block of content) {
        const b = block as Record<string, unknown>;
        if (b.type === "tool_use") out.push(toolUseToCall(String(b.name ?? ""), b.input));
      }
    } else if (entry.type === "tool_use") {
      out.push(toolUseToCall(String(entry.name ?? ""), entry.input));
    }
  }
  return out;
}
```

- [ ] **Step 4: Implement `src/normalizers/index.ts`**

```ts
// src/normalizers/index.ts
import type { ToolCall } from "../contracts/verdict.ts";
import { normalizeClaudeLogs } from "./claude.ts";

export type Normalizer = (raw: string) => ToolCall[];

/** Spec 1 ships claude only; Spec 2 fans out the remaining dialects. */
export const NORMALIZERS: Record<string, Normalizer> = {
  claude: normalizeClaudeLogs,
};
```

- [ ] **Step 5: Run tests to verify pass**

Run: `bun test test/normalizers-claude.test.ts && bun run typecheck`
Expected: PASS (3 tests).

- [ ] **Step 6: Commit**

```bash
git add src/normalizers test/normalizers-claude.test.ts
git commit -m "feat(quorum-ts): claude session-log normalizer (PRI-2207)"
```

---

## Task 5: Capture — snapshot/diff + tool-calls

**Reference:** `quorum/capture.py` (`snapshot_dir`, `new_files_since`, `capture_tool_calls`). Snapshot = set of relative path strings under `log_dir` matching `glob`. New files = current − snapshot, sorted. `captureToolCalls` runs the normalizer over each new log and writes `coding-agent-tool-calls.jsonl` (always written, even if empty). For claude, no cwd filtering.

**Files:**
- Create: `src/capture/index.ts`
- Test: `test/capture.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// test/capture.test.ts
import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { captureToolCalls, newFilesSince, snapshotDir } from "../src/capture/index.ts";

test("snapshot then diff finds only new files", () => {
  const logDir = mkdtempSync(join(tmpdir(), "logs-"));
  writeFileSync(join(logDir, "old.jsonl"), "");
  const snap = snapshotDir(logDir, "**/*.jsonl");
  writeFileSync(join(logDir, "new.jsonl"), "");
  const fresh = newFilesSince(logDir, "**/*.jsonl", snap);
  expect(fresh.map((p) => p.split("/").pop())).toEqual(["new.jsonl"]);
});

test("captureToolCalls writes coding-agent-tool-calls.jsonl from claude logs", () => {
  const logDir = mkdtempSync(join(tmpdir(), "logs-"));
  const runDir = mkdtempSync(join(tmpdir(), "run-"));
  const snap = snapshotDir(logDir, "**/*.jsonl");
  writeFileSync(
    join(logDir, "s.jsonl"),
    JSON.stringify({ type: "tool_use", name: "Bash", input: { command: "ls" } }),
  );
  const res = captureToolCalls({ logDir, logGlob: "**/*.jsonl", snapshot: snap, normalizer: "claude", runDir });
  expect(res.rowCount).toBe(1);
  const written = readFileSync(join(runDir, "coding-agent-tool-calls.jsonl"), "utf8").trim();
  expect(JSON.parse(written)).toEqual({ tool: "Bash", args: { command: "ls" }, source: "shell" });
});

test("captureToolCalls writes an empty file when there are no new logs", () => {
  const logDir = mkdtempSync(join(tmpdir(), "logs-"));
  const runDir = mkdtempSync(join(tmpdir(), "run-"));
  const res = captureToolCalls({ logDir, logGlob: "**/*.jsonl", snapshot: new Set(), normalizer: "claude", runDir });
  expect(res.rowCount).toBe(0);
  expect(readFileSync(join(runDir, "coding-agent-tool-calls.jsonl"), "utf8")).toBe("");
});
```

- [ ] **Step 2: Run it to verify failure**

Run: `bun test test/capture.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/capture/index.ts`**

```ts
// src/capture/index.ts
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { Glob } from "bun";
import { NORMALIZERS } from "../normalizers/index.ts";

function globRel(logDir: string, glob: string): Map<string, string> {
  const out = new Map<string, string>();
  if (!existsSync(logDir)) return out;
  for (const abs of new Glob(glob).scanSync({ cwd: logDir, absolute: true })) {
    out.set(relative(logDir, abs), abs);
  }
  return out;
}

export function snapshotDir(logDir: string, glob: string): Set<string> {
  return new Set(globRel(logDir, glob).keys());
}

export function newFilesSince(logDir: string, glob: string, snapshot: Set<string>): string[] {
  const cur = globRel(logDir, glob);
  return [...cur.keys()].filter((k) => !snapshot.has(k)).sort().map((k) => cur.get(k) as string);
}

export interface CaptureArgs {
  logDir: string;
  logGlob: string;
  snapshot: Set<string>;
  normalizer: string;
  runDir: string;
}
export interface CaptureResult {
  path: string;
  sourceLogs: string[];
  rowCount: number;
}

export function captureToolCalls(args: CaptureArgs): CaptureResult {
  const { logDir, logGlob, snapshot, normalizer, runDir } = args;
  const newLogs = newFilesSince(logDir, logGlob, snapshot);
  const fn = NORMALIZERS[normalizer];
  if (!fn) throw new Error(`unknown normalizer: ${normalizer}`);
  const lines: string[] = [];
  for (const log of newLogs) {
    for (const rec of fn(readFileSync(log, "utf8"))) lines.push(JSON.stringify(rec));
  }
  const outPath = join(runDir, "coding-agent-tool-calls.jsonl");
  writeFileSync(outPath, lines.length ? `${lines.join("\n")}\n` : "");
  return { path: outPath, sourceLogs: newLogs, rowCount: lines.length };
}
```

- [ ] **Step 4: Run tests to verify pass**

Run: `bun test test/capture.test.ts && bun run typecheck`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/capture test/capture.test.ts
git commit -m "feat(quorum-ts): session-log snapshot/diff + tool-call capture (PRI-2207)"
```

---

## Task 6: obol wrapper + mergeEstimates

**Reference:** `quorum/obol_capture.py`. `estimateSessionLogs(family, files)` maps family→dialect (identity for the 8 known dialects), calls `estimatePath(file, dialect)` per file, merges via `mergeEstimates`. `mergeEstimates` sums per-model token buckets + subtotals across `CostEstimate.per_model` (note obol's `tokens.cache_write` → our `total_cache_create`), dedupes approximations by `(kind, detail)`, keeps first non-null `pricing_as_of`, returns `null` if `total_tokens === 0`. `est_cost_usd` is `null` when all priced models are unpriced; per-model and total costs `round(…, 10)`. Only `ObolError` is caught (→ `null`).

**Files:**
- Create: `src/obol/index.ts`
- Test: `test/obol.test.ts`

- [ ] **Step 1: Write the failing test (pure mergeEstimates; no native lib needed)**

```ts
// test/obol.test.ts
import { expect, test } from "bun:test";
import { mergeEstimates } from "../src/obol/index.ts";

// Minimal CostEstimate-shaped fixtures (only fields mergeEstimates reads).
const est = (overrides: Record<string, unknown> = {}) => ({
  total_usd: 0.5,
  pricing_as_of: "2026-06-09",
  unpriced_models: [] as string[],
  approximations: [] as { kind: string; detail: string | null }[],
  per_model: [
    {
      model: "claude-opus-4-8",
      provider: "anthropic",
      subtotal_usd: 0.5,
      tokens: { input: 100, output: 20, cache_write: 5, cache_read: 3 },
    },
  ],
  ...overrides,
});

test("sums tokens, maps cache_write->total_cache_create, rounds cost", () => {
  const merged = mergeEstimates([est() as never, est() as never]);
  expect(merged).not.toBeNull();
  const m = merged as NonNullable<typeof merged>;
  expect(m.total_input).toBe(200);
  expect(m.total_cache_create).toBe(10);
  expect(m.total_output).toBe(40);
  expect(m.total_tokens).toBe(200 + 10 + 6 + 40);
  expect(m.est_cost_usd).toBe(1);
  expect(m.model).toBe("claude-opus-4-8");
  expect(m.pricing_as_of).toBe("2026-06-09");
});

test("returns null when total_tokens is 0", () => {
  const zero = est({ per_model: [] });
  expect(mergeEstimates([zero as never])).toBeNull();
});

test("est_cost_usd is null when every model is unpriced", () => {
  const merged = mergeEstimates([est({ unpriced_models: ["claude-opus-4-8"] }) as never]);
  expect((merged as NonNullable<typeof merged>).est_cost_usd).toBeNull();
  expect((merged as NonNullable<typeof merged>).unpriced_models).toEqual(["claude-opus-4-8"]);
});
```

- [ ] **Step 2: Run it to verify failure**

Run: `bun test test/obol.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/obol/index.ts`**

```ts
// src/obol/index.ts
import { estimatePath, ObolError } from "@primeradianthq/obol";
import type { CostEstimate } from "@primeradianthq/obol";
import type { TokenUsage } from "../contracts/economics.ts";

/** backend family (normalizer name) -> obol dialect. Identity for the 8 known dialects. */
export const DIALECTS: Record<string, string> = {
  claude: "claude", codex: "codex", copilot: "copilot", gemini: "gemini",
  kimi: "kimi", opencode: "opencode", pi: "pi",
};

const BUCKET_KEYS = ["total_input", "total_cache_create", "total_cache_read", "total_output"] as const;
const round10 = (n: number) => Math.round(n * 1e10) / 1e10;

interface Bucket {
  total_input: number;
  total_cache_create: number;
  total_cache_read: number;
  total_output: number;
  provider: string;
  subtotal_usd: number;
}

export function mergeEstimates(estimates: CostEstimate[]): TokenUsage | null {
  const perModel = new Map<string, Bucket>();
  const unpriced = new Set<string>();
  const approximations: { kind: string; detail: string | null }[] = [];
  const seenApprox = new Set<string>();
  let pricingAsOf: string | null = null;

  for (const est of estimates) {
    pricingAsOf = pricingAsOf ?? est.pricing_as_of ?? null;
    for (const m of est.unpriced_models ?? []) unpriced.add(m);
    for (const a of est.approximations ?? []) {
      const key = JSON.stringify([a.kind, a.detail ?? null]); // tuple key: null != "" (parity)
      if (!seenApprox.has(key)) {
        seenApprox.add(key);
        approximations.push({ kind: a.kind, detail: a.detail ?? null });
      }
    }
    for (const mc of est.per_model ?? []) {
      const b = perModel.get(mc.model) ?? {
        total_input: 0, total_cache_create: 0, total_cache_read: 0,
        total_output: 0, provider: mc.provider, subtotal_usd: 0,
      };
      b.total_input += mc.tokens.input;
      b.total_cache_create += mc.tokens.cache_write;
      b.total_cache_read += mc.tokens.cache_read;
      b.total_output += mc.tokens.output;
      b.subtotal_usd += mc.subtotal_usd;
      perModel.set(mc.model, b);
    }
  }

  const totals = { total_input: 0, total_cache_create: 0, total_cache_read: 0, total_output: 0 };
  for (const b of perModel.values()) for (const k of BUCKET_KEYS) totals[k] += b[k];
  const totalTokens = BUCKET_KEYS.reduce((s, k) => s + totals[k], 0);
  if (totalTokens === 0) return null;

  const allUnpriced = perModel.size > 0 && [...perModel.keys()].every((m) => unpriced.has(m));
  const models: TokenUsage["models"] = {};
  let topModel: string | null = null;
  let topCost = -1;
  let totalUsd = 0;
  for (const [name, b] of perModel) {
    const tokens = b.total_input + b.total_cache_create + b.total_cache_read + b.total_output;
    models[name] = {
      total_input: b.total_input, total_cache_create: b.total_cache_create,
      total_cache_read: b.total_cache_read, total_output: b.total_output,
      total_tokens: tokens, provider: b.provider,
      est_cost_usd: unpriced.has(name) ? null : round10(b.subtotal_usd),
    };
    totalUsd += b.subtotal_usd;
    if (b.subtotal_usd > topCost) { topCost = b.subtotal_usd; topModel = name; }
  }

  return {
    ...totals,
    total_tokens: totalTokens,
    model: topModel,
    models,
    est_cost_usd: allUnpriced ? null : round10(totalUsd),
    unpriced_models: [...unpriced].sort(),
    approximations,
    pricing_as_of: pricingAsOf,
  };
}

export async function estimateSessionLogs(family: string, files: string[]): Promise<TokenUsage | null> {
  const dialect = DIALECTS[family];
  if (!dialect || files.length === 0) return null;
  const estimates: CostEstimate[] = [];
  try {
    for (const f of files) estimates.push(await estimatePath(f, dialect as never));
  } catch (e) {
    if (e instanceof ObolError) return null;
    throw e;
  }
  return mergeEstimates(estimates);
}

export async function estimateUsageSidecar(path: string): Promise<TokenUsage | null> {
  const { existsSync } = await import("node:fs");
  if (!existsSync(path)) return null;
  try {
    return mergeEstimates([await estimatePath(path, "obol" as never)]);
  } catch (e) {
    if (e instanceof ObolError) return null;
    throw e;
  }
}
```

- [ ] **Step 4: Run tests to verify pass**

Run: `bun test test/obol.test.ts && bun run typecheck`
Expected: PASS (3 tests). (Pure `mergeEstimates`; no native lib touched.)

- [ ] **Step 5: Commit**

```bash
git add src/obol test/obol.test.ts
git commit -m "feat(quorum-ts): obol wrapper + mergeEstimates token accounting (PRI-2207)"
```

---

## Task 7: Token-usage capture + economics composition

**Reference:** `quorum/capture.py` (`capture_token_usage`) and `quorum/economics.py` (`build_run_economics`). `captureTokenUsage` prices new session logs and writes `coding-agent-token-usage.json` (with `duration_ms`). `buildRunEconomics` reads that frozen file + prices `gauntlet-agent/results/<runId>/usage.jsonl`, composes the `economics` block: nested `gauntlet`/`coding_agent` blocks (each with `duration_ms`, `model`, `tokens` shell, `est_cost_usd`, `has_unpriced_model`, `obol` provenance), `total_est_cost_usd` (`round(g+c, 6)` only if both present and none unpriced), `partial` flag.

**Files:**
- Create: `src/economics.ts`; extend `src/capture/index.ts` with `captureTokenUsage`
- Test: `test/economics.test.ts`

- [ ] **Step 1: Write the failing test (composition is pure given a frozen token-usage file)**

```ts
// test/economics.test.ts
import { expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildRunEconomics } from "../src/economics.ts";

function frozenUsage(runDir: string) {
  writeFileSync(
    join(runDir, "coding-agent-token-usage.json"),
    JSON.stringify({
      total_input: 100, total_cache_create: 5, total_cache_read: 3, total_output: 20,
      total_tokens: 128, model: "claude-opus-4-8",
      models: { "claude-opus-4-8": {
        total_input: 100, total_cache_create: 5, total_cache_read: 3, total_output: 20,
        total_tokens: 128, provider: "anthropic", est_cost_usd: 0.5,
      } },
      est_cost_usd: 0.5, unpriced_models: [], approximations: [], pricing_as_of: "2026-06-09",
      duration_ms: 9000,
    }),
  );
}

test("builds economics from a frozen coding-agent usage file with no gauntlet usage", async () => {
  const runDir = mkdtempSync(join(tmpdir(), "run-"));
  frozenUsage(runDir);
  const econ = await buildRunEconomics(runDir);
  expect(econ).not.toBeNull();
  const e = econ as NonNullable<typeof econ>;
  expect(e.coding_agent?.est_cost_usd).toBe(0.5);
  expect(e.coding_agent?.tokens.total).toBe(128);
  expect(e.gauntlet).toBeNull();
  // gauntlet missing => partial, total uncomputed
  expect(e.partial).toBe(true);
  expect(e.total_est_cost_usd).toBeNull();
});

test("gauntlet result.json with no usage sidecar still yields a gauntlet block (zero tokens)", async () => {
  const runDir = mkdtempSync(join(tmpdir(), "run-"));
  const rdir = join(runDir, "gauntlet-agent", "results", "g_0000");
  mkdirSync(rdir, { recursive: true });
  writeFileSync(join(rdir, "result.json"), JSON.stringify({ status: "pass", duration_ms: 1200, config: { model: "claude-opus-4-8" } }));
  const econ = await buildRunEconomics(runDir); // usage.jsonl absent -> estimateUsageSidecar returns null without calling obol
  const e = econ as NonNullable<typeof econ>;
  expect(e.gauntlet).not.toBeNull();
  expect((e.gauntlet as { tokens: { total: number } }).tokens.total).toBe(0);
  expect((e.gauntlet as { est_cost_usd: number | null }).est_cost_usd).toBeNull();
  expect((e.gauntlet as { model: string }).model).toBe("claude-opus-4-8");
});

test("returns null when neither source exists", async () => {
  const runDir = mkdtempSync(join(tmpdir(), "run-"));
  expect(await buildRunEconomics(runDir)).toBeNull();
});
```

- [ ] **Step 2: Run it to verify failure**

Run: `bun test test/economics.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/economics.ts`**

```ts
// src/economics.ts
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Glob } from "bun";
import { TokenUsageSchema, type TokenUsage } from "./contracts/economics.ts";
import { estimateUsageSidecar } from "./obol/index.ts";

interface TokenShell { input: number; output: number; cache_create: number; cache_read: number; total: number }
const round6 = (n: number) => Math.round(n * 1e6) / 1e6;
const ZERO_TOKENS: TokenShell = { input: 0, output: 0, cache_create: 0, cache_read: 0, total: 0 };

/** Tolerant JSON read (Python economics._read_json): malformed/missing -> null, never throws. */
function readJsonLoose(path: string): Record<string, unknown> | null {
  try {
    const d = JSON.parse(readFileSync(path, "utf8")) as unknown;
    return d && typeof d === "object" ? (d as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function tokensShell(u: TokenUsage): TokenShell {
  return {
    input: u.total_input, output: u.total_output, cache_create: u.total_cache_create,
    cache_read: u.total_cache_read, total: u.total_tokens,
  };
}
function obolProvenance(u: TokenUsage) {
  if (!u.pricing_as_of) return null;
  return {
    per_model: u.models, unpriced_models: u.unpriced_models,
    approximations: u.approximations, pricing_as_of: u.pricing_as_of,
  };
}

/** First sorted results dir carrying a result.json (Python economics._gauntlet_results_dir
 *  uses `next(sorted(...))` — first, not newest; Spec-1 has exactly one per run). */
function gauntletResultPath(runDir: string): string | null {
  const base = join(runDir, "gauntlet-agent", "results");
  if (!existsSync(base)) return null;
  const hits = [...new Glob("*/result.json").scanSync({ cwd: base, absolute: true })].sort();
  return hits[0] ?? null;
}

export async function buildRunEconomics(runDir: string): Promise<Record<string, unknown> | null> {
  // gauntlet block — built whenever result.json OR usage exists; null only if both absent
  // (parity with Python economics._gauntlet_block).
  let gauntlet: Record<string, unknown> | null = null;
  const resultPath = gauntletResultPath(runDir);
  const gResult = resultPath ? readJsonLoose(resultPath) : null;
  const gUsage = resultPath ? await estimateUsageSidecar(join(resultPath, "..", "usage.jsonl")) : null;
  if (gResult || gUsage) {
    const dur = (gResult as { duration_ms?: unknown } | null)?.duration_ms;
    const configModel = (gResult as { config?: { model?: string } } | null)?.config?.model ?? null;
    gauntlet = {
      duration_ms: typeof dur === "number" ? Math.trunc(dur) : null,
      model: gUsage?.model ?? configModel,
      tokens: gUsage ? tokensShell(gUsage) : { ...ZERO_TOKENS },
      est_cost_usd: gUsage?.est_cost_usd ?? null,
      has_unpriced_model: (gUsage?.unpriced_models.length ?? 0) > 0,
      obol: gUsage ? obolProvenance(gUsage) : null,
    };
  }

  // coding-agent block (frozen, already priced at capture time)
  let coding: Record<string, unknown> | null = null;
  const codingPath = join(runDir, "coding-agent-token-usage.json");
  if (existsSync(codingPath)) {
    const u = TokenUsageSchema.parse(JSON.parse(readFileSync(codingPath, "utf8")));
    const modelsList = Object.entries(u.models)
      .map(([model, m]) => ({
        model,
        tokens: { input: m.total_input, output: m.total_output, cache_create: m.total_cache_create, cache_read: m.total_cache_read, total: m.total_tokens },
        est_cost_usd: m.est_cost_usd,
      }))
      .sort((a, b) => (b.est_cost_usd ?? -1) - (a.est_cost_usd ?? -1));
    const hasUnpriced = u.unpriced_models.length > 0 || modelsList.some((m) => m.est_cost_usd === null);
    coding = {
      duration_ms: u.duration_ms ?? null,
      model: u.model,
      models: modelsList,
      tokens: tokensShell(u),
      est_cost_usd: u.est_cost_usd,
      tool_result_total_bytes: u.tool_result_total_bytes ?? 0,
      has_unpriced_model: hasUnpriced,
      obol: obolProvenance(u),
    };
  }

  if (!gauntlet && !coding) return null;

  const gCost = (gauntlet?.est_cost_usd ?? null) as number | null;
  const cCost = (coding?.est_cost_usd ?? null) as number | null;
  const anyUnpriced = Boolean(coding?.has_unpriced_model) || Boolean(gauntlet?.has_unpriced_model);
  const total = gCost !== null && cCost !== null && !anyUnpriced ? round6(gCost + cCost) : null;
  const partial = !gauntlet || !coding || gCost === null || cCost === null || anyUnpriced;
  // Python iterates (coding, gauntlet) — coding first.
  const pricingAsof =
    ((coding?.obol as { pricing_as_of?: string } | null)?.pricing_as_of ??
      (gauntlet?.obol as { pricing_as_of?: string } | null)?.pricing_as_of) ?? null;

  return { pricing_asof: pricingAsof, gauntlet, coding_agent: coding, total_est_cost_usd: total, partial };
}
```

- [ ] **Step 4: Add `captureTokenUsage` to `src/capture/index.ts`**

Append to `src/capture/index.ts`:

```ts
import { estimateSessionLogs } from "../obol/index.ts";

/** Price new session logs, write coding-agent-token-usage.json (with duration_ms). Null on failure. */
export async function captureTokenUsage(args: CaptureArgs): Promise<string | null> {
  const newLogs = newFilesSince(args.logDir, args.logGlob, args.snapshot);
  const usage = await estimateSessionLogs(args.normalizer, newLogs);
  if (!usage) return null;
  usage.duration_ms = sessionDurationMs(newLogs);
  const outPath = join(args.runDir, "coding-agent-token-usage.json");
  writeFileSync(outPath, `${JSON.stringify(usage, null, 2)}\n`);
  return outPath;
}

/** First-to-last timestamp span across session logs (best-effort; null if undecodable). */
function sessionDurationMs(_files: string[]): number | null {
  // Spec 1: claude session logs carry per-line timestamps; full span extraction lands in Spec 2
  // alongside the timing module. The walking skeleton tolerates null here.
  return null;
}
```

- [ ] **Step 5: Run tests to verify pass**

Run: `bun test test/economics.test.ts && bun run typecheck`
Expected: PASS (2 tests).

- [ ] **Step 6: Commit**

```bash
git add src/economics.ts src/capture/index.ts test/economics.test.ts
git commit -m "feat(quorum-ts): token-usage capture + economics composition (PRI-2207)"
```

---

## Task 8: Checks bridge (run_phase)

**Reference:** `quorum/checks.py`. Runs `bash -c "source '<checks.sh>'; <phase>"` with `cwd=workdir`, `PATH=<quorumBin>:<PATH>`, env `QUORUM_RECORD_SINK` (tmp jsonl), optional `QUORUM_TOOL_CALLS_PATH`, `QUORUM_RUN_DIR`. Parses one `CheckRecord` per sink line (`{check, args, negated, passed, detail}` + injected `phase`). Crash heuristic: rc 0 → ok; rc∈{126,127} or rc≥128 → crash; rc 1–125 → ok if any records else crash. `bin/` is reused untouched — `quorumBin` points at the existing repo `bin/`.

**Files:**
- Create: `src/checks/index.ts`
- Test: `test/checks.test.ts`

- [ ] **Step 1: Write the failing test (uses the real repo `bin/`)**

```ts
// test/checks.test.ts
import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseCodingAgentsDirective, runPhase } from "../src/checks/index.ts";

const BIN = resolve(import.meta.dir, "..", "bin");

test("pre() emitting a passing file-exists record is collected", async () => {
  const workdir = mkdtempSync(join(tmpdir(), "wd-"));
  writeFileSync(join(workdir, "present.txt"), "x");
  const checksSh = join(mkdtempSync(join(tmpdir(), "scn-")), "checks.sh");
  writeFileSync(checksSh, "pre() {\n  file-exists present.txt\n}\npost() { :; }\n");
  const { records, exitCode } = await runPhase({ checksSh, phase: "pre", workdir, quorumBin: BIN });
  expect(exitCode).toBe(0);
  expect(records).toHaveLength(1);
  expect(records[0]).toMatchObject({ check: "file-exists", args: ["present.txt"], passed: true, phase: "pre" });
});

test("parseCodingAgentsDirective reads a leading '# coding-agents:' csv", () => {
  const checksSh = join(mkdtempSync(join(tmpdir(), "scn-")), "checks.sh");
  writeFileSync(checksSh, "# coding-agents: claude, codex\npre() { :; }\npost() { :; }\n");
  expect(parseCodingAgentsDirective(checksSh)).toEqual(["claude", "codex"]);
});
```

- [ ] **Step 2: Run it to verify failure**

Run: `bun test test/checks.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/checks/index.ts`**

```ts
// src/checks/index.ts
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { CheckRecordSchema, type CheckRecord, type CheckPhase } from "../contracts/verdict.ts";

export interface RunPhaseArgs {
  checksSh: string;
  phase: CheckPhase;
  workdir: string;
  quorumBin: string;
  toolCallsPath?: string;
  runDir?: string;
}

export async function runPhase(args: RunPhaseArgs): Promise<{ records: CheckRecord[]; exitCode: number }> {
  const sinkDir = mkdtempSync(join(tmpdir(), "sink-"));
  const sink = join(sinkDir, "records.jsonl");
  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    PATH: `${args.quorumBin}:${process.env.PATH ?? ""}`,
    QUORUM_RECORD_SINK: sink,
  };
  if (args.toolCallsPath) env.QUORUM_TOOL_CALLS_PATH = args.toolCallsPath;
  if (args.runDir) env.QUORUM_RUN_DIR = args.runDir;

  const proc = spawnSync("bash", ["-c", `source '${args.checksSh}'; ${args.phase}`], {
    cwd: args.workdir,
    env,
    encoding: "utf8",
  });
  const rc = proc.status ?? 0;

  let records: CheckRecord[] = [];
  try {
    records = readFileSync(sink, "utf8")
      .split("\n")
      .filter((l) => l.trim())
      .map((l) => {
        const d = JSON.parse(l) as Record<string, unknown>;
        return CheckRecordSchema.parse({
          check: d.check, args: d.args, negated: d.negated, passed: d.passed,
          detail: d.detail ?? null, phase: args.phase,
        });
      });
  } catch {
    records = [];
  } finally {
    rmSync(sinkDir, { recursive: true, force: true });
  }

  // Crash heuristic (matches Python checks.py): distinguish tool failure from bash crash.
  let exitCode: number;
  if (rc === 0) exitCode = 0;
  else if (rc === 126 || rc === 127 || rc >= 128) exitCode = rc;
  else exitCode = records.length > 0 ? 0 : rc;
  return { records, exitCode };
}

export function parseCodingAgentsDirective(checksSh: string): string[] | null {
  const head = readFileSync(checksSh, "utf8").split("\n").slice(0, 20);
  for (const line of head) {
    const g = line.match(/^#\s*coding-agents:\s*(.+)$/)?.[1];
    if (g) return g.split(",").map((s) => s.trim()).filter(Boolean);
  }
  return null;
}
```

- [ ] **Step 4: Run tests to verify pass**

Run: `bun test test/checks.test.ts && bun run typecheck`
Expected: PASS (2 tests). Requires `jq` on PATH (already used by the bash tools).

- [ ] **Step 5: Commit**

```bash
git add src/checks test/checks.test.ts
git commit -m "feat(quorum-ts): checks bridge over bash checks.sh + bin/ (PRI-2207)"
```

---

## Task 9: story-meta + setup runner

**Reference:** `quorum/story_meta.py`, `quorum/setup_step.py`. Frontmatter is lenient (not full YAML): `^---\n(.*?)\n---`, split each line on first `:`, strip whitespace + surrounding quotes. `quorum_max_time` validated `^\d+(ms|s|m|h)?$`; `quorum_tier` ∈ {sentinel, full, adhoc} default `full`; `status` default `ready`. `runSetup` runs `setup.sh` in `workdir` with `QUORUM_WORKDIR` set; non-zero exit throws `SetupError` carrying stdout+stderr.

**Files:**
- Create: `src/story-meta.ts`, `src/setup-step.ts`
- Test: `test/story-meta.test.ts`, `test/setup-step.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
// test/story-meta.test.ts
import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readQuorumMaxTime, readQuorumTier, readStoryStatus } from "../src/story-meta.ts";

function story(body: string): string {
  const p = join(mkdtempSync(join(tmpdir(), "story-")), "story.md");
  writeFileSync(p, body);
  return p;
}

test("reads quorum_max_time, tier, status with quote tolerance + defaults", () => {
  const p = story(`---\nquorum_max_time: "90m"\nquorum_tier: sentinel\n---\nbody`);
  expect(readQuorumMaxTime(p)).toBe("90m");
  expect(readQuorumTier(p)).toBe("sentinel");
  expect(readStoryStatus(p)).toBe("ready");
});

test("defaults when frontmatter absent", () => {
  const p = story(`no frontmatter here`);
  expect(readQuorumMaxTime(p)).toBeNull();
  expect(readQuorumTier(p)).toBe("full");
});
```

```ts
// test/setup-step.test.ts
import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runSetup, SetupError } from "../src/setup-step.ts";

test("runSetup runs setup.sh in workdir with QUORUM_WORKDIR", () => {
  const scn = mkdtempSync(join(tmpdir(), "scn-"));
  const wd = mkdtempSync(join(tmpdir(), "wd-"));
  writeFileSync(join(scn, "setup.sh"), '#!/usr/bin/env bash\necho "$QUORUM_WORKDIR" > marker.txt\n');
  chmodSync(join(scn, "setup.sh"), 0o755);
  runSetup(scn, wd);
  expect(readFileSync(join(wd, "marker.txt"), "utf8").trim()).toBe(wd);
});

test("non-zero setup.sh throws SetupError with output", () => {
  const scn = mkdtempSync(join(tmpdir(), "scn-"));
  const wd = mkdtempSync(join(tmpdir(), "wd-"));
  writeFileSync(join(scn, "setup.sh"), '#!/usr/bin/env bash\necho boom >&2\nexit 3\n');
  chmodSync(join(scn, "setup.sh"), 0o755);
  expect(() => runSetup(scn, wd)).toThrow(SetupError);
});
```

- [ ] **Step 2: Run them to verify failure**

Run: `bun test test/story-meta.test.ts test/setup-step.test.ts`
Expected: FAIL — modules not found.

- [ ] **Step 3: Implement `src/story-meta.ts`**

```ts
// src/story-meta.ts
import { readFileSync } from "node:fs";

export class StoryMetaError extends Error {}

function frontmatter(storyPath: string): Map<string, string> {
  const text = readFileSync(storyPath, "utf8");
  const body = text.match(/^---\n([\s\S]*?)\n---/)?.[1];
  const out = new Map<string, string>();
  if (body === undefined) return out;
  for (const line of body.split("\n")) {
    const i = line.indexOf(":");
    if (i === -1) continue;
    const key = line.slice(0, i).trim();
    let val = line.slice(i + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (key) out.set(key, val);
  }
  return out;
}

export function readQuorumMaxTime(storyPath: string): string | null {
  const v = frontmatter(storyPath).get("quorum_max_time");
  if (v === undefined) return null;
  if (!/^\d+(ms|s|m|h)?$/.test(v)) throw new StoryMetaError(`invalid quorum_max_time: ${v}`);
  return v;
}

export function readQuorumTier(storyPath: string): "sentinel" | "full" | "adhoc" {
  const v = frontmatter(storyPath).get("quorum_tier") ?? "full";
  if (v !== "sentinel" && v !== "full" && v !== "adhoc") {
    throw new StoryMetaError(`invalid quorum_tier: ${v}`);
  }
  return v;
}

export function readStoryStatus(storyPath: string): string {
  return frontmatter(storyPath).get("status") ?? "ready";
}
```

- [ ] **Step 4: Implement `src/setup-step.ts`**

```ts
// src/setup-step.ts
import { spawnSync } from "node:child_process";
import { join } from "node:path";

export class SetupError extends Error {}

/** Run scenario setup.sh in workdir with QUORUM_WORKDIR set. Throws SetupError on non-zero exit. */
export function runSetup(scenarioDir: string, workdir: string, envExtra: Record<string, string> = {}): void {
  const script = join(scenarioDir, "setup.sh");
  const proc = spawnSync(script, [], {
    cwd: workdir,
    env: { ...(process.env as Record<string, string>), QUORUM_WORKDIR: workdir, ...envExtra },
    encoding: "utf8",
  });
  if ((proc.status ?? 0) !== 0) {
    throw new SetupError(`setup.sh failed (exit ${proc.status})\nstdout:\n${proc.stdout}\nstderr:\n${proc.stderr}`);
  }
}
```

- [ ] **Step 5: Run tests to verify pass**

Run: `bun test test/story-meta.test.ts test/setup-step.test.ts && bun run typecheck`
Expected: PASS (4 tests).

- [ ] **Step 6: Commit**

```bash
git add src/story-meta.ts src/setup-step.ts test/story-meta.test.ts test/setup-step.test.ts
git commit -m "feat(quorum-ts): story frontmatter + setup.sh runner (PRI-2207)"
```

---

## Task 10: Composer (three-valued verdict)

**Reference:** `quorum/composer.py` — port the 6-case tree exactly. `TRACE_PRIMITIVES` is the set of trace-check names; an empty capture only forces indeterminate when a trace check is present.

**Files:**
- Create: `src/composer.ts`
- Test: `test/composer.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// test/composer.test.ts
import { expect, test } from "bun:test";
import { compose } from "../src/composer.ts";
import type { CheckRecord, GauntletLayer } from "../src/contracts/verdict.ts";

const G = (status: GauntletLayer["status"]): GauntletLayer => ({ status, summary: "", reasoning: "", run_id: "r" });
const post = (passed: boolean): CheckRecord => ({ check: "file-exists", args: [], negated: false, passed, detail: null, phase: "post" });

test("error -> indeterminate with stage in reason", () => {
  const v = compose({ gauntlet: null, checks: [], captureEmpty: false, error: { stage: "setup", message: "boom" } });
  expect(v.final).toBe("indeterminate");
  expect(v.final_reason).toContain("quorum error (setup)");
});

test("failed pre-check -> indeterminate", () => {
  const pre: CheckRecord = { check: "git-repo", args: [], negated: false, passed: false, detail: null, phase: "pre" };
  expect(compose({ gauntlet: G("pass"), checks: [pre], captureEmpty: false, error: null }).final).toBe("indeterminate");
});

test("gauntlet investigate -> indeterminate", () => {
  expect(compose({ gauntlet: G("investigate"), checks: [], captureEmpty: false, error: null }).final).toBe("indeterminate");
});

test("gauntlet pass + no failed post -> pass", () => {
  expect(compose({ gauntlet: G("pass"), checks: [post(true)], captureEmpty: false, error: null }).final).toBe("pass");
});

test("gauntlet pass + failed post -> fail", () => {
  expect(compose({ gauntlet: G("pass"), checks: [post(false)], captureEmpty: false, error: null }).final).toBe("fail");
});

test("empty capture + trace check -> indeterminate", () => {
  const trace: CheckRecord = { check: "tool-called", args: ["Bash"], negated: false, passed: true, detail: null, phase: "post" };
  expect(compose({ gauntlet: G("pass"), checks: [trace], captureEmpty: true, error: null }).final).toBe("indeterminate");
});
```

- [ ] **Step 2: Run it to verify failure**

Run: `bun test test/composer.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/composer.ts`**

```ts
// src/composer.ts
import type { CheckRecord, FinalVerdict, GauntletLayer, RunError } from "./contracts/verdict.ts";

const TRACE_PRIMITIVES = new Set([
  "tool-called", "tool-not-called", "tool-count", "tool-before",
  "tool-arg-match", "tool-match-before-tool-match",
  "skill-called", "skill-not-called", "skill-before-tool", "skill-before-tool-match",
]);

export interface ComposeArgs {
  gauntlet: GauntletLayer | null;
  checks: CheckRecord[];
  captureEmpty: boolean;
  error: RunError | null;
}

export function compose({ gauntlet, checks, captureEmpty, error }: ComposeArgs): FinalVerdict {
  const base = { schema: 1 as const, gauntlet, checks, economics: null };

  if (error) {
    return { ...base, final: "indeterminate", final_reason: `quorum error (${error.stage}): ${error.message}`, error };
  }
  const failedPre = checks.filter((c) => c.phase === "pre" && !c.passed);
  if (failedPre.length) {
    return { ...base, final: "indeterminate", final_reason: `pre-check(s) failed: ${failedPre.map((c) => c.check).join(", ")}`, error: null };
  }
  if (!gauntlet) {
    return { ...base, final: "indeterminate", final_reason: "no Gauntlet-Agent verdict", error: null };
  }
  if (gauntlet.status === "investigate" || gauntlet.status === "errored") {
    return { ...base, final: "indeterminate", final_reason: `Gauntlet-Agent did not complete (status: ${gauntlet.status})`, error: null };
  }
  if (captureEmpty && checks.some((c) => TRACE_PRIMITIVES.has(c.check))) {
    return { ...base, final: "indeterminate", final_reason: "tool-call capture was empty; trace checks meaningless", error: null };
  }
  const failedPost = checks.filter((c) => c.phase === "post" && !c.passed);
  if (gauntlet.status === "pass" && failedPost.length === 0) {
    const n = checks.filter((c) => c.phase === "post").length;
    const reason = n ? `Gauntlet-Agent passed; ${n} post-check(s) passed` : "Gauntlet-Agent passed; no deterministic checks";
    return { ...base, final: "pass", final_reason: reason, error: null };
  }
  const bits: string[] = [];
  if (gauntlet.status !== "pass") bits.push(`Gauntlet-Agent reported ${gauntlet.status}`);
  if (failedPost.length) bits.push(`${failedPost.length} post-check(s) failed`);
  return { ...base, final: "fail", final_reason: bits.join("; ") || "fail", error: null };
}
```

- [ ] **Step 4: Run tests to verify pass**

Run: `bun test test/composer.test.ts && bun run typecheck`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add src/composer.ts test/composer.test.ts
git commit -m "feat(quorum-ts): three-valued verdict composer (PRI-2207)"
```

---

## Task 11: Runner pipeline

**Reference:** `quorum/runner.py`. `allocateRunDir` → `<outRoot>/<scenario>-<agent>-<stamp>-<nonce>/`. `runScenario` orchestrates: setup (mkdir subdirs, provision claude config, run `setup.sh`), pre-checks, snapshot session-log dir, `invokeGauntlet`, capture tool-calls + token usage, post-checks, `buildRunEconomics`, `compose`, write `verdict.json`. `invokeGauntlet` spawns the exact gauntlet argv and discovers `result.json` by globbing `gauntlet-agent/results/*/result.json` (newest). The claude provisioning (skeleton copy, `.claude.json` trust, `.claude-env`) is faithful but minimal here; the agent abstraction (`src/agents`) is introduced in Step 3.

**Files:**
- Create: `src/agents/index.ts`, `src/runner/index.ts`
- Test: `test/runner.test.ts` (uses mock-gauntlet from Task 12 — write this test in Task 12; here we test `allocateRunDir` + `invokeGauntlet` discovery in isolation)

- [ ] **Step 1: Write the failing test for run-dir naming + gauntlet argv build**

```ts
// test/runner-unit.test.ts
import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, basename } from "node:path";
import { allocateRunDir, buildGauntletArgv } from "../src/runner/index.ts";

test("allocateRunDir names <scenario>-<agent>-<stamp>-<nonce> and creates it", () => {
  const out = mkdtempSync(join(tmpdir(), "out-"));
  const dir = allocateRunDir(out, "00-quorum-smoke-hello-world", "claude");
  expect(basename(dir)).toMatch(/^00-quorum-smoke-hello-world-claude-\d{8}T\d{6}Z-[0-9a-f]{4}$/);
});

test("buildGauntletArgv is exact and order-stable", () => {
  const argv = buildGauntletArgv({
    storyPath: "/s/story.md", targetBinary: "claude", runDir: "/r", maxTime: "10m", projectPrompt: "/r/p.md",
  });
  expect(argv).toEqual([
    "run", "/s/story.md", "--adapter", "tui", "--target", "claude",
    "--project-dir", "/r", "--state-dir", "gauntlet-agent", "--silent",
    "--max-time", "10m", "--project-prompt", "/r/p.md",
  ]);
});
```

- [ ] **Step 2: Run it to verify failure**

Run: `bun test test/runner-unit.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/agents/index.ts`**

```ts
// src/agents/index.ts
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { AgentConfig } from "../contracts/agent-config.ts";

export interface RunHome {
  configDir: string; // the agent_config_env dir (e.g. CLAUDE_CONFIG_DIR)
  workdir: string;
  skeletonRoot: string | null;
}

export interface CodingAgent {
  readonly config: AgentConfig;
  /** Seed the isolated agent-config dir; return extra env to pass to gauntlet. */
  provision(home: RunHome): Record<string, string>;
}

/** Declarative agents whose provisioning is fully driven by YAML (Spec 2 widens this set). */
class DefaultAgent implements CodingAgent {
  constructor(readonly config: AgentConfig) {}
  provision(home: RunHome): Record<string, string> {
    mkdirSync(home.configDir, { recursive: true });
    return { [this.config.agent_config_env]: home.configDir };
  }
}

class ClaudeAgent implements CodingAgent {
  constructor(readonly config: AgentConfig) {}
  provision(home: RunHome): Record<string, string> {
    const { configDir, workdir, skeletonRoot } = home;
    const skel = skeletonRoot ? join(skeletonRoot, `${this.config.runtime_family ?? "claude"}-home-skeleton`) : null;
    if (skel && existsSync(skel)) cpSync(skel, configDir, { recursive: true });
    else mkdirSync(configDir, { recursive: true });

    // Trust the project so claude doesn't prompt.
    const claudeJsonPath = join(configDir, ".claude.json");
    const claudeJson = existsSync(claudeJsonPath)
      ? (JSON.parse(readFileSync(claudeJsonPath, "utf8")) as Record<string, unknown>)
      : {};
    const projects = (claudeJson.projects as Record<string, unknown>) ?? {};
    projects[resolve(workdir)] = {
      hasTrustDialogAccepted: true,
      projectOnboardingSeenCount: 1,
      hasClaudeMdExternalIncludesApproved: true,
    };
    claudeJson.projects = projects;
    writeFileSync(claudeJsonPath, JSON.stringify(claudeJson, null, 2));

    const apiKey = process.env.ANTHROPIC_API_KEY ?? "";
    const envFile = join(configDir, ".claude-env");
    writeFileSync(envFile, `ANTHROPIC_API_KEY=${shellSingleQuote(apiKey)}\n`, { mode: 0o600 });
    return { [this.config.agent_config_env]: configDir };
  }
}

function shellSingleQuote(s: string): string {
  return `'${s.replaceAll("'", `'\\''`)}'`;
}

export function resolveAgent(config: AgentConfig): CodingAgent {
  if ((config.runtime_family ?? config.name) === "claude") return new ClaudeAgent(config);
  return new DefaultAgent(config);
}
```

- [ ] **Step 4: Implement `src/runner/index.ts`**

```ts
// src/runner/index.ts
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { Glob } from "bun";
import { loadAgentConfig, substituteEnv } from "../contracts/agent-config.ts";
import { GauntletResultSchema } from "../contracts/gauntlet.ts";
import type { FinalVerdict, GauntletLayer, RunError } from "../contracts/verdict.ts";
import { captureToolCalls, captureTokenUsage, snapshotDir } from "../capture/index.ts";
import { runPhase } from "../checks/index.ts";
import { compose } from "../composer.ts";
import { buildRunEconomics } from "../economics.ts";
import { resolveAgent } from "../agents/index.ts";
import { runSetup, SetupError } from "../setup-step.ts";
import { readQuorumMaxTime } from "../story-meta.ts";
import { hexNonce, nowStampUtc } from "../paths.ts";

export function allocateRunDir(outRoot: string, scenario: string, agent: string): string {
  const dir = join(outRoot, `${scenario}-${agent}-${nowStampUtc()}-${hexNonce()}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

export interface GauntletArgvArgs {
  storyPath: string;
  targetBinary: string;
  runDir: string;
  maxTime?: string | null;
  projectPrompt?: string | null;
}
export function buildGauntletArgv(a: GauntletArgvArgs): string[] {
  const argv = [
    "run", a.storyPath, "--adapter", "tui", "--target", a.targetBinary,
    "--project-dir", a.runDir, "--state-dir", "gauntlet-agent", "--silent",
  ];
  if (a.maxTime) argv.push("--max-time", a.maxTime);
  if (a.projectPrompt) argv.push("--project-prompt", a.projectPrompt);
  return argv;
}

function discoverGauntletResult(runDir: string): string | null {
  const base = join(runDir, "gauntlet-agent", "results");
  if (!existsSync(base)) return null;
  return [...new Glob("*/result.json").scanSync({ cwd: base, absolute: true })].sort().at(-1) ?? null;
}

export interface InvokeGauntletArgs extends GauntletArgvArgs {
  launchCwd: string;
  extraEnv: Record<string, string>;
}
export function invokeGauntlet(a: InvokeGauntletArgs): { gauntlet: GauntletLayer | null; error: RunError | null } {
  const proc = spawnSync("gauntlet", buildGauntletArgv(a), {
    env: { ...(process.env as Record<string, string>), QUORUM_AGENT_CWD: a.launchCwd, ...a.extraEnv },
    encoding: "utf8",
  });
  if ((proc.status ?? 0) !== 0) {
    return { gauntlet: null, error: { stage: "gauntlet", message: `gauntlet exited ${proc.status}\n${proc.stderr}` } };
  }
  const resultPath = discoverGauntletResult(a.runDir);
  if (!resultPath) {
    return { gauntlet: null, error: { stage: "gauntlet", message: "no gauntlet result.json found" } };
  }
  const result = GauntletResultSchema.parse(JSON.parse(readFileSync(resultPath, "utf8")));
  return {
    gauntlet: { status: result.status, summary: result.summary, reasoning: result.reasoning, run_id: result.runId ?? null },
    error: null,
  };
}

export interface RunScenarioArgs {
  scenarioDir: string;
  codingAgent: string;
  codingAgentsDir: string;
  outRoot: string;
  skeletonRoot?: string | null;
}

export async function runScenario(a: RunScenarioArgs): Promise<{ runDir: string; verdict: FinalVerdict }> {
  const scenario = a.scenarioDir.split("/").filter(Boolean).pop() as string;
  const runDir = allocateRunDir(a.outRoot, scenario, a.codingAgent);
  let verdict: FinalVerdict;
  try {
    verdict = await runInner({ ...a, scenario, runDir });
  } catch (err) {
    const stage = (err as { stage?: RunError["stage"] }).stage ?? (err instanceof SetupError ? "setup" : "unknown");
    verdict = compose({ gauntlet: null, checks: [], captureEmpty: false, error: { stage, message: String((err as Error).message ?? err) } });
  }
  writeFileSync(join(runDir, "verdict.json"), `${JSON.stringify(verdict, null, 2)}\n`);
  return { runDir, verdict };
}

async function runInner(a: RunScenarioArgs & { scenario: string; runDir: string }): Promise<FinalVerdict> {
  const cfg = loadAgentConfig(a.codingAgentsDir, a.codingAgent);
  for (const key of cfg.required_env) {
    if (!process.env[key]) throw Object.assign(new Error(`${a.codingAgent}.yaml: required env var not set: ${key}`), { stage: "setup" as const });
  }
  const agent = resolveAgent(cfg);

  // setup
  const configDir = join(a.runDir, "coding-agent-config");
  const workdir = join(a.runDir, "coding-agent-workdir");
  mkdirSync(workdir, { recursive: true });
  const extraEnv = agent.provision({ configDir, workdir, skeletonRoot: a.skeletonRoot ?? null });
  runSetup(a.scenarioDir, workdir);

  const checksSh = join(a.scenarioDir, "checks.sh");
  const quorumBin = join(process.cwd(), "bin");

  // pre-checks
  const pre = existsSync(checksSh) ? await runPhase({ checksSh, phase: "pre", workdir, quorumBin, runDir: a.runDir }) : { records: [], exitCode: 0 };
  if (pre.exitCode !== 0) {
    return compose({ gauntlet: null, checks: pre.records, captureEmpty: false, error: { stage: "checks", message: `pre-checks crashed (exit ${pre.exitCode})` } });
  }
  if (pre.records.some((r) => !r.passed)) {
    return compose({ gauntlet: null, checks: pre.records, captureEmpty: false, error: null });
  }

  // snapshot agent session-log dir before the run
  const logDir = substituteEnv(cfg.session_log_dir, extraEnv);
  const snapshot = snapshotDir(logDir, cfg.session_log_glob);

  // drive gauntlet
  const storyPath = join(a.scenarioDir, "story.md");
  const maxTime = readQuorumMaxTime(storyPath) ?? cfg.max_time ?? null;
  // launch cwd: honor a .quorum-launch-cwd sentinel if setup.sh wrote one (Python _resolve_launch_cwd)
  const launchCwdFile = join(workdir, ".quorum-launch-cwd");
  const launchCwd = existsSync(launchCwdFile) ? readFileSync(launchCwdFile, "utf8").trim() : workdir;
  const { gauntlet, error } = invokeGauntlet({
    storyPath, targetBinary: cfg.binary, runDir: a.runDir, maxTime,
    launchCwd, extraEnv,
  });
  if (error) return compose({ gauntlet, checks: pre.records, captureEmpty: false, error });

  // capture
  const capture = captureToolCalls({ logDir, logGlob: cfg.session_log_glob, snapshot, normalizer: cfg.normalizer, runDir: a.runDir });
  // writes coding-agent-token-usage.json as a side effect (null if obol can't price); path not needed here
  await captureTokenUsage({ logDir, logGlob: cfg.session_log_glob, snapshot, normalizer: cfg.normalizer, runDir: a.runDir });
  const captureEmpty = capture.rowCount === 0;

  // post-checks
  const toolCallsPath = capture.path;
  const post = existsSync(checksSh) ? await runPhase({ checksSh, phase: "post", workdir, quorumBin, toolCallsPath, runDir: a.runDir }) : { records: [], exitCode: 0 };
  if (post.exitCode !== 0) {
    return compose({ gauntlet, checks: [...pre.records, ...post.records], captureEmpty, error: { stage: "checks", message: `post-checks crashed (exit ${post.exitCode})` } });
  }

  // compose + economics
  const verdict = compose({ gauntlet, checks: [...pre.records, ...post.records], captureEmpty, error: null });
  verdict.economics = await buildRunEconomics(a.runDir);
  return verdict;
}
```

- [ ] **Step 5: Run the unit test to verify pass**

Run: `bun test test/runner-unit.test.ts && bun run typecheck`
Expected: PASS (2 tests). (Full `runScenario` is covered end-to-end in Task 12.)

- [ ] **Step 6: Commit**

```bash
git add src/agents src/runner test/runner-unit.test.ts
git commit -m "feat(quorum-ts): runner pipeline + claude provisioning + gauntlet invocation (PRI-2207)"
```

---

## Task 12: mock-gauntlet harness + end-to-end runner test

**Goal:** A stub `gauntlet` that, given `MOCK_GAUNTLET_FIXTURE`, drops a canned `result.json` (+ optional `usage.jsonl`) into `<project-dir>/gauntlet-agent/results/<runId>/` and a canned claude session log into the agent's `session_log_dir`, then exits 0. Put it first on `PATH` in the test. This proves the whole runner pipeline for $0.

**Files:**
- Create: `test/mock-gauntlet/mock-gauntlet.ts`, fixtures under `test/mock-gauntlet/fixtures/`
- Test: `test/runner-e2e.test.ts`

- [ ] **Step 1: Write the mock-gauntlet stub**

```ts
#!/usr/bin/env bun
// test/mock-gauntlet/mock-gauntlet.ts
// Emulates `gauntlet run <story> --adapter tui --target <t> --project-dir <dir> --state-dir gauntlet-agent ...`
import { cpSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const argv = process.argv.slice(2);
const pdIdx = argv.indexOf("--project-dir");
const projectDir = pdIdx >= 0 ? argv[pdIdx + 1] : undefined;
const fixture = process.env.MOCK_GAUNTLET_FIXTURE;
if (!projectDir || !fixture) {
  console.error("mock-gauntlet: need --project-dir and MOCK_GAUNTLET_FIXTURE");
  process.exit(2);
}
const fixtureDir = join(import.meta.dir, "fixtures", fixture);

// 1) gauntlet result artifacts
const runId = `mock_${fixture}_0000`;
const resultsDir = join(projectDir, "gauntlet-agent", "results", runId);
mkdirSync(resultsDir, { recursive: true });
cpSync(join(fixtureDir, "result.json"), join(resultsDir, "result.json"));
if (existsSync(join(fixtureDir, "usage.jsonl"))) {
  cpSync(join(fixtureDir, "usage.jsonl"), join(resultsDir, "usage.jsonl"));
}

// 2) canned coding-agent session log into CLAUDE_CONFIG_DIR/projects/<slug>/<session>.jsonl
const sessionSrc = join(fixtureDir, "claude-session.jsonl");
if (existsSync(sessionSrc)) {
  const configDir = process.env.CLAUDE_CONFIG_DIR;
  if (configDir) {
    const dest = join(configDir, "projects", "mock");
    mkdirSync(dest, { recursive: true });
    cpSync(sessionSrc, join(dest, `${runId}.jsonl`));
  }
}
process.exit(0);
```

- [ ] **Step 2: Write fixtures**

`test/mock-gauntlet/fixtures/pass/result.json`:
```json
{ "schemaVersion": 5, "runId": "mock_pass_0000", "status": "pass", "summary": "ok", "reasoning": "all ACs met", "duration_ms": 1000, "config": { "model": "claude-opus-4-8" } }
```

`test/mock-gauntlet/fixtures/pass/claude-session.jsonl`:
```json
{"type":"tool_use","name":"Bash","input":{"command":"git status"}}
{"type":"tool_use","name":"Read","input":{"file_path":"/x"}}
```

`test/mock-gauntlet/fixtures/fail-no-usage/result.json`:
```json
{ "schemaVersion": 5, "runId": "mock_fail_0000", "status": "fail", "summary": "no", "reasoning": "AC2 unmet", "duration_ms": 500, "config": { "model": "claude-opus-4-8" } }
```

(For Spec 1 we skip a real `usage.jsonl` fixture — obol pricing needs the native lib + a pricing snapshot, which the e2e test runs without; economics will be `partial`/`null`, which is the correct behavior when usage is absent. A priced fixture is added in Spec 2 alongside the obol smoke test.)

- [ ] **Step 3: Write the failing end-to-end test**

```ts
// test/runner-e2e.test.ts
import { expect, test } from "bun:test";
import { chmodSync, mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { runScenario } from "../src/runner/index.ts";

const REPO = resolve(import.meta.dir, "..");
const MOCK = resolve(import.meta.dir, "mock-gauntlet");

function makeScenario(): string {
  const dir = mkdtempSync(join(tmpdir(), "scn-"));
  writeFileSync(join(dir, "story.md"), `---\nquorum_max_time: 1m\n---\nDo the thing.`);
  writeFileSync(join(dir, "setup.sh"), "#!/usr/bin/env bash\n:\n");
  chmodSync(join(dir, "setup.sh"), 0o755);
  writeFileSync(join(dir, "checks.sh"), "pre() { :; }\npost() { :; }\n");
  return dir;
}

test("mock-gauntlet drives a full pass run to a parity verdict", async () => {
  const scenarioDir = makeScenario();
  const outRoot = mkdtempSync(join(tmpdir(), "out-"));
  // claude.yaml the runner will load
  const agentsDir = mkdtempSync(join(tmpdir(), "agents-"));
  writeFileSync(join(agentsDir, "claude.yaml"), [
    "name: claude", "runtime_family: claude", "binary: claude",
    "agent_config_env: CLAUDE_CONFIG_DIR",
    'session_log_dir: "${CLAUDE_CONFIG_DIR}/projects"',
    'session_log_glob: "**/*.jsonl"', "normalizer: claude",
    "required_env:", "  - ANTHROPIC_API_KEY",
  ].join("\n"));

  const prevPath = process.env.PATH;
  const prevKey = process.env.ANTHROPIC_API_KEY;
  const prevFixture = process.env.MOCK_GAUNTLET_FIXTURE;
  process.env.PATH = `${MOCK}:${prevPath}`;            // mock-gauntlet.ts must be chmod +x and named `gauntlet` on PATH
  process.env.ANTHROPIC_API_KEY = "sk-test";
  process.env.MOCK_GAUNTLET_FIXTURE = "pass";
  try {
    const { runDir, verdict } = await runScenario({
      scenarioDir, codingAgent: "claude", codingAgentsDir: agentsDir, outRoot,
    });
    expect(verdict.schema).toBe(1);
    expect(verdict.final).toBe("pass");
    expect(verdict.gauntlet?.status).toBe("pass");
    expect(runDir).toContain(outRoot);
  } finally {
    process.env.PATH = prevPath;
    if (prevKey === undefined) delete process.env.ANTHROPIC_API_KEY; else process.env.ANTHROPIC_API_KEY = prevKey;
    if (prevFixture === undefined) delete process.env.MOCK_GAUNTLET_FIXTURE; else process.env.MOCK_GAUNTLET_FIXTURE = prevFixture;
  }
});
```

- [ ] **Step 4: Make mock-gauntlet resolvable as `gauntlet`**

The runner spawns the literal binary `gauntlet`. Create an executable shim named `gauntlet` in the mock dir that execs the stub:

```bash
cat > test/mock-gauntlet/gauntlet <<'EOF'
#!/usr/bin/env bash
exec bun "$(dirname "$0")/mock-gauntlet.ts" "$@"
EOF
chmod +x test/mock-gauntlet/gauntlet
```

- [ ] **Step 5: Run the e2e test to verify it fails, then passes**

Run: `bun test test/runner-e2e.test.ts`
Expected first run (before shim exists): FAIL (gauntlet not found). After Step 4: PASS — `verdict.final === "pass"`.

- [ ] **Step 6: Commit**

```bash
git add test/mock-gauntlet test/runner-e2e.test.ts
git commit -m "test(quorum-ts): mock-gauntlet harness + end-to-end runner pass-path (PRI-2207)"
```

---

## Task 13: `run` CLI command

**Reference:** `quorum/cli.py` `run`. Args: `scenario_dir` (required, must exist); options `--coding-agent` (required), `--coding-agents-dir` (default `coding-agents`), `--out-root` (default `results`). Prints `run-id: <run_dir.name>`, renders the verdict, exits `{pass:0, fail:1, indeterminate:2}[final]`.

**Files:**
- Create: `src/cli/index.ts` (run only here; show added in Task 14)
- Test: `test/cli-run.test.ts`

- [ ] **Step 1: Write the failing test (spawn the CLI with mock-gauntlet on PATH)**

```ts
// test/cli-run.test.ts
import { expect, test } from "bun:test";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const CLI = resolve(import.meta.dir, "..", "src", "cli", "index.ts");
const MOCK = resolve(import.meta.dir, "mock-gauntlet");

test("quorum run exits 1 on a fail verdict and prints run-id", () => {
  const scn = mkdtempSync(join(tmpdir(), "scn-"));
  writeFileSync(join(scn, "story.md"), "---\nquorum_max_time: 1m\n---\nx");
  writeFileSync(join(scn, "setup.sh"), "#!/usr/bin/env bash\n:\n");
  chmodSync(join(scn, "setup.sh"), 0o755);
  writeFileSync(join(scn, "checks.sh"), "pre() { :; }\npost() { :; }\n");
  const agents = mkdtempSync(join(tmpdir(), "agents-"));
  writeFileSync(join(agents, "claude.yaml"), [
    "name: claude", "runtime_family: claude", "binary: claude",
    "agent_config_env: CLAUDE_CONFIG_DIR",
    'session_log_dir: "${CLAUDE_CONFIG_DIR}/projects"',
    'session_log_glob: "**/*.jsonl"', "normalizer: claude",
    "required_env:", "  - ANTHROPIC_API_KEY",
  ].join("\n"));
  const out = mkdtempSync(join(tmpdir(), "out-"));

  const proc = spawnSync("bun", [CLI, "run", scn, "--coding-agent", "claude", "--coding-agents-dir", agents, "--out-root", out], {
    env: { ...process.env, PATH: `${MOCK}:${process.env.PATH}`, ANTHROPIC_API_KEY: "sk-test", MOCK_GAUNTLET_FIXTURE: "fail-no-usage" },
    encoding: "utf8",
  });
  expect(proc.stdout).toContain("run-id:");
  expect(proc.status).toBe(1);
});
```

- [ ] **Step 2: Run it to verify failure**

Run: `bun test test/cli-run.test.ts`
Expected: FAIL — CLI module not found.

- [ ] **Step 3: Implement `src/cli/index.ts`**

```ts
#!/usr/bin/env bun
// src/cli/index.ts
import { resolve } from "node:path";
import { existsSync } from "node:fs";
import { Command } from "commander";
import { runScenario } from "../runner/index.ts";
import { render } from "./render.ts";

const EXIT: Record<string, number> = { pass: 0, fail: 1, indeterminate: 2 };

const program = new Command();
program.name("quorum").description("Behavioral eval runner (TypeScript)");

program
  .command("run")
  .argument("<scenario-dir>", "scenario directory")
  .requiredOption("--coding-agent <name>", "coding agent to run")
  .option("--coding-agents-dir <dir>", "agents dir", "coding-agents")
  .option("--out-root <dir>", "results root", "results")
  .action(async (scenarioDir: string, opts: { codingAgent: string; codingAgentsDir: string; outRoot: string }) => {
    const scn = resolve(scenarioDir);
    if (!existsSync(scn)) {
      process.stderr.write(`scenario dir not found: ${scn}\n`);
      process.exit(2);
    }
    const { runDir, verdict } = await runScenario({
      scenarioDir: scn,
      codingAgent: opts.codingAgent,
      codingAgentsDir: resolve(opts.codingAgentsDir),
      outRoot: resolve(opts.outRoot),
    });
    process.stdout.write(`run-id: ${runDir.split("/").at(-1) ?? runDir}\n`);
    process.stdout.write(render(verdict, runDir, { color: process.stdout.isTTY ?? false, mode: "full" }));
    process.exit(EXIT[verdict.final]);
  });

program.parseAsync(process.argv);
```

- [ ] **Step 4: Stub `src/cli/render.ts` (full impl in Task 14)**

```ts
// src/cli/render.ts
import type { FinalVerdict } from "../contracts/verdict.ts";

export type ShowMode = "full" | "quiet" | "json";

export function render(verdict: FinalVerdict, runDir: string, opts: { color: boolean; mode: ShowMode }): string {
  if (opts.mode === "json") return `${JSON.stringify(verdict, null, 2)}\n`;
  if (opts.mode === "quiet") return `${verdict.final}\n${verdict.final_reason}\n`;
  return `${runDir.split("/").pop()}\n${verdict.final}: ${verdict.final_reason}\n`;
}
```

- [ ] **Step 5: Run tests to verify pass**

Run: `bun test test/cli-run.test.ts && bun run typecheck`
Expected: PASS — exit code 1, `run-id:` printed.

- [ ] **Step 6: Commit**

```bash
git add src/cli test/cli-run.test.ts
git commit -m "feat(quorum-ts): quorum run CLI command (PRI-2207)"
```

---

## Task 14: `show` CLI command + render

**Reference:** `quorum/cli.py` `show` + `quorum/show.py`. Args: optional `target`; options `-q/--quiet`, `--json`, `--no-color`, `--results-root` (default `results`). `--quiet` + `--json` together → exit 1. Resolves target (newest run by `verdict.json` mtime when omitted; dir-with-verdict.json; verdict.json file → parent; prefix `results_root/<target>-*` newest). Exit codes: 0 success (display only — never a verdict carrier), 1 resolution failure, 2 malformed/schema-mismatch verdict.

**Files:**
- Modify: `src/cli/index.ts` (add `show`), `src/cli/render.ts` (full render)
- Create: `src/cli/resolve-target.ts`
- Test: `test/cli-show.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// test/cli-show.test.ts
import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const CLI = resolve(import.meta.dir, "..", "src", "cli", "index.ts");

function runDirWithVerdict(final: "pass" | "fail" | "indeterminate"): { root: string; dir: string } {
  const root = mkdtempSync(join(tmpdir(), "results-"));
  const dir = join(root, `scn-claude-20260612T010101Z-abcd`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "verdict.json"), JSON.stringify({
    schema: 1, final, final_reason: "because", gauntlet: null, checks: [], error: null, economics: null,
  }));
  return { root, dir };
}

test("show --quiet prints final + reason and exits 0 even for a fail verdict", () => {
  const { dir } = runDirWithVerdict("fail");
  const proc = spawnSync("bun", [CLI, "show", dir, "--quiet"], { encoding: "utf8" });
  expect(proc.status).toBe(0);
  expect(proc.stdout).toBe("fail\nbecause\n");
});

test("show --quiet --json together exits 1", () => {
  const { dir } = runDirWithVerdict("pass");
  const proc = spawnSync("bun", [CLI, "show", dir, "--quiet", "--json"], { encoding: "utf8" });
  expect(proc.status).toBe(1);
});

test("show with no target resolves newest run under results-root", () => {
  const { root } = runDirWithVerdict("pass");
  const proc = spawnSync("bun", [CLI, "show", "--results-root", root, "--json"], { encoding: "utf8" });
  expect(proc.status).toBe(0);
  expect(JSON.parse(proc.stdout).final).toBe("pass");
});
```

- [ ] **Step 2: Run it to verify failure**

Run: `bun test test/cli-show.test.ts`
Expected: FAIL — `show` not implemented / resolve-target missing.

- [ ] **Step 3: Implement `src/cli/resolve-target.ts`**

```ts
// src/cli/resolve-target.ts
import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

export class ShowError extends Error {}

function newestRunDir(resultsRoot: string): string | null {
  if (!existsSync(resultsRoot)) return null;
  const candidates = readdirSync(resultsRoot)
    .map((n) => join(resultsRoot, n))
    .filter((p) => existsSync(join(p, "verdict.json")))
    .map((p) => ({ p, mtime: statSync(join(p, "verdict.json")).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);
  return candidates[0]?.p ?? null;
}

export function resolveTarget(target: string | undefined, resultsRoot: string): string {
  if (target === undefined) {
    const newest = newestRunDir(resultsRoot);
    if (!newest) throw new ShowError("no runs found");
    return newest;
  }
  if (existsSync(join(target, "verdict.json"))) return target;                 // dir with verdict.json
  if (target.endsWith("verdict.json") && existsSync(target)) return join(target, "..");
  // prefix match under results-root, newest by mtime
  if (existsSync(resultsRoot)) {
    const prefix = `${target}-`;
    const matches = readdirSync(resultsRoot)
      .filter((n) => n.startsWith(prefix))
      .map((n) => join(resultsRoot, n))
      .filter((p) => existsSync(join(p, "verdict.json")))
      .map((p) => ({ p, mtime: statSync(join(p, "verdict.json")).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime);
    const first = matches[0];
    if (first) return first.p;
  }
  throw new ShowError(`could not resolve target: ${target}`);
}
```

- [ ] **Step 4: Replace `src/cli/render.ts` with the full renderer**

```ts
// src/cli/render.ts
import type { FinalVerdict } from "../contracts/verdict.ts";

export type ShowMode = "full" | "quiet" | "json";

const RGB: Record<string, [number, number, number]> = {
  pass: [80, 250, 123], fail: [255, 85, 85], indeterminate: [241, 250, 140],
};
const color = (s: string, rgb: [number, number, number], on: boolean) =>
  on ? `\x1b[38;2;${rgb[0]};${rgb[1]};${rgb[2]}m${s}\x1b[0m` : s;

export function render(verdict: FinalVerdict, runDir: string, opts: { color: boolean; mode: ShowMode }): string {
  if (opts.mode === "json") return `${JSON.stringify(verdict, null, 2)}\n`;
  if (opts.mode === "quiet") return `${verdict.final}\n${verdict.final_reason}\n`;

  const lines: string[] = [];
  lines.push(runDir.split("/").pop() ?? runDir);
  lines.push(`${color(verdict.final.toUpperCase(), RGB[verdict.final], opts.color)}  ${verdict.final_reason}`);
  if (verdict.gauntlet) {
    lines.push(`gauntlet: ${verdict.gauntlet.status}`);
    if (verdict.gauntlet.summary) lines.push(`  ${verdict.gauntlet.summary}`);
  }
  for (const phase of ["pre", "post"] as const) {
    for (const c of verdict.checks.filter((x) => x.phase === phase)) {
      const glyph = c.passed ? "✓" : "✗";
      const not = c.negated ? "NOT " : "";
      lines.push(`  [${phase}] ${glyph} ${not}${c.check} ${c.args.join(" ")}${c.detail ? ` ↳ ${c.detail}` : ""}`);
    }
  }
  if (verdict.economics) {
    const total = (verdict.economics as { total_est_cost_usd?: number | null }).total_est_cost_usd;
    lines.push(`economics: ${total === null || total === undefined ? "(partial)" : `$${total}`}`);
  }
  return `${lines.join("\n")}\n`;
}
```

- [ ] **Step 5: Add the `show` command to `src/cli/index.ts`**

Insert before `program.parseAsync(process.argv);`:

```ts
import { readFileSync } from "node:fs";
import { FinalVerdictSchema } from "../contracts/verdict.ts";
import { resolveTarget, ShowError } from "./resolve-target.ts";

program
  .command("show")
  .argument("[target]", "run-dir, verdict.json, or scenario prefix")
  .option("-q, --quiet", "final + reason only", false)
  .option("--json", "raw verdict json", false)
  .option("--no-color", "disable color")
  .option("--results-root <dir>", "results root", "results")
  .action((target: string | undefined, opts: { quiet: boolean; json: boolean; color: boolean; resultsRoot: string }) => {
    if (opts.quiet && opts.json) {
      process.stderr.write("--quiet and --json are mutually exclusive\n");
      process.exit(1);
    }
    let runDir: string;
    try {
      runDir = resolveTarget(target, resolve(opts.resultsRoot));
    } catch (e) {
      if (e instanceof ShowError) {
        process.stderr.write(`${e.message}\n`);
        process.exit(1);
      }
      throw e;
    }
    let verdict: ReturnType<typeof FinalVerdictSchema.parse>;
    try {
      verdict = FinalVerdictSchema.parse(JSON.parse(readFileSync(join(runDir, "verdict.json"), "utf8")));
    } catch {
      process.stderr.write("malformed verdict.json\n");
      process.exit(2);
    }
    const mode = opts.json ? "json" : opts.quiet ? "quiet" : "full";
    process.stdout.write(render(verdict, runDir, { color: opts.color && (process.stdout.isTTY ?? false), mode }));
    process.exit(0);
  });
```

> **Implementer note:** update the existing path import in `src/cli/index.ts` from `import { resolve } from "node:path";` to `import { join, resolve } from "node:path";` — the `show` action uses `join` to read `verdict.json`.

- [ ] **Step 6: Run tests to verify pass**

Run: `bun test test/cli-show.test.ts && bun run typecheck`
Expected: PASS (3 tests).

- [ ] **Step 7: Commit**

```bash
git add src/cli test/cli-show.test.ts
git commit -m "feat(quorum-ts): quorum show CLI command + verdict renderer (PRI-2207)"
```

---

## Task 15: Claude replay-differential test (the parity oracle)

**Goal:** Prove the capture+normalize+compose chain reproduces the Python's `coding-agent-tool-calls.jsonl` for a real recorded claude session. Mine one real completed claude run from `results/` (a run-dir that has both a claude session log under `coding-agent-config/projects/**` and a `coding-agent-tool-calls.jsonl`), and assert the TS normalizer reproduces the same tool-call rows.

**Files:**
- Create: `test/fixtures/claude/` (copy one real session `.jsonl` + the Python-produced `coding-agent-tool-calls.jsonl`), `test/replay-claude.test.ts`

- [ ] **Step 1: Mine a real claude fixture**

Run:
```bash
# find a completed claude run with a captured tool-calls file and a session log
ls -d results/*-claude-* 2>/dev/null | while read d; do
  tc="$d/coding-agent-tool-calls.jsonl"
  sess=$(find "$d/coding-agent-config/projects" -name '*.jsonl' 2>/dev/null | head -1)
  if [ -s "$tc" ] && [ -n "$sess" ]; then echo "DIR=$d"; echo "SESSION=$sess"; echo "TOOLCALLS=$tc"; break; fi
done
```
Copy the discovered `SESSION` to `test/fixtures/claude/session.jsonl` and `TOOLCALLS` to `test/fixtures/claude/expected-tool-calls.jsonl`.

> If no eligible run exists locally, generate the fixture from a synthetic session: write `test/fixtures/claude/session.jsonl` with 3-4 `{"type":"tool_use",...}` lines and produce `expected-tool-calls.jsonl` by running the **Python** normalizer once: `uv run python -c "from quorum.normalizers import normalize_claude_logs; import json,sys; [print(json.dumps(r)) for r in normalize_claude_logs(open('test/fixtures/claude/session.jsonl').read())]" > test/fixtures/claude/expected-tool-calls.jsonl`. This freezes the Python output as the oracle.

- [ ] **Step 2: Write the failing replay test**

```ts
// test/replay-claude.test.ts
import { expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { normalizeClaudeLogs } from "../src/normalizers/claude.ts";

const FIX = resolve(import.meta.dir, "fixtures", "claude");

test("TS claude normalizer reproduces the Python tool-call rows for a real session", () => {
  const session = resolve(FIX, "session.jsonl");
  const expectedPath = resolve(FIX, "expected-tool-calls.jsonl");
  if (!existsSync(session) || !existsSync(expectedPath)) {
    throw new Error("fixture missing — run Task 15 Step 1 to mine/generate it");
  }
  const got = normalizeClaudeLogs(readFileSync(session, "utf8"));
  const expected = readFileSync(expectedPath, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
  expect(got).toEqual(expected);
});
```

- [ ] **Step 3: Run it to verify pass**

Run: `bun test test/replay-claude.test.ts`
Expected: PASS — TS rows deep-equal the frozen Python rows.

- [ ] **Step 4: Run the full suite + checks**

Run: `bun test && bun run typecheck && bun run lint`
Expected: all tests green, typecheck clean, lint clean.

- [ ] **Step 5: Commit**

```bash
git add test/fixtures/claude test/replay-claude.test.ts
git commit -m "test(quorum-ts): claude replay-differential parity oracle (PRI-2207)"
```

---

## Definition of Done (Spec 1)

- `quorum run <scenario> --coding-agent claude` produces a `verdict.json` with the exact 7-key shape, driven end-to-end by mock-gauntlet for the pass and fail paths, exit codes `{pass:0, fail:1, indeterminate:2}`.
- `quorum show` resolves targets and renders full/quiet/json, exit `0/1/2` per its display semantics.
- The claude normalizer reproduces real Python tool-call output (replay-differential green).
- `bun test`, `tsc --noEmit`, and `biome check` are all green.
- Every scary seam is proven: gauntlet subprocess contract, capture→normalize, checks-bridge over real `bin/`, obol `mergeEstimates`, economics composition, three-valued composer, `verdict.json` write, CLI exit codes.

**Deferred to later specs (out of scope here):** the 7 other normalizers + custom agent adapters (Spec 2); `list`/`new`/`check` + setup-helpers (Spec 3); scheduler + run-all (Spec 4, PRI-2203); dashboard (Spec 5); live parity smoke + Python deletion (Spec 6). The `sessionDurationMs` timing span and a priced obol fixture also land in Spec 2.

**Deferred live-gauntlet provisioning (intentional):** the full claude provisioning the real `gauntlet` tui adapter needs — generating the executable `launch-agent` shim, populating `gauntlet-agent/context/` with HOWTO substitutions (`$QUORUM_AGENT_CWD`, `$CLAUDE_CONFIG_DIR`, …), and wiring `--project-prompt` from the agent config — is **not** required by mock-gauntlet (it never execs the agent). Spec 1 therefore seeds only the config dir (`.claude.json` trust + `.claude-env`). `buildGauntletArgv` already supports `--project-prompt` (unit-tested in isolation); the runner wires it, plus launch-agent/context-dir population, when real-gauntlet provisioning is added (alongside the Spec 6 live smoke). The e2e exercises obol's bundled native binding (it ships in the npm package and prices offline) — a genuine, not mocked, obol round-trip.
