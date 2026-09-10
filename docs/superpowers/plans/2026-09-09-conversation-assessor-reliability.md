# Conversation Assessor Reliability Implementation Plan

> **USER SCOPE OVERRIDE — no bespoke launcher (2026-09-10 UTC).** Drew explicitly said: "i don't want a bespoke launcher. i'm so confused". This supersedes the bespoke Task8/Task9 implementation, preparation, authority, packaging and execution design. The subsequent explicit user direction authorizes only bounded cleanup, verification and a successor source commit, including this controller-authored override. Preserve historical evidence and the exact snapshot of pre-cleanup dirty work; remove the active bespoke code without replacement. No additional team/review cascade, paid/provider calls, staging, provisioning or frozen-manifest regeneration is authorized.

## Current deliverable and integration boundary

Finish the independently useful deferred-handler/evidence-retention fixture repair;
retain ordinary Quorum/Gauntlet lifecycle, capture and accounting improvements,
offline reconstruction/classification, semantic data and shared qualification
mechanics. Remove the dated launcher/preparation/authority/relocation/refusal
modules, live diagnostic loop and proposal generation, and launcher-only tests.
Update the spec/readout, run bounded focused regressions/lint/typecheck, and
make a successor commit. The integration coordinator owns final aggregate/paired
checks on the combined tree; this worker stops its already-running aggregate
and does not start or repeat broad checks. The integration coordinator owns push/merge; no
reset, rebase, push or merge belongs to this cleanup worker.

Source-merge eligibility is explicitly independent of live qualification. The
candidate remains empirically unqualified; merging code grants no deployment or
execution authority. The existing `evals-appliance campaign register|list|run|status|cancel|costs|report`
interface is the operator route. Ordinary `quorum run` → `runScenario` →
`runPreparedConversation` → `invokeGauntletRole` → `gauntlet assess` workers run
beneath that owner. The earlier dated `conversation-routine-use/run.ts` is an old
campaign-helper wrapper, not a second active runtime. Missing normal-CLI body-capture/physical-cap plumbing
and exact-prefix resume are documentation gaps only, not new work here. The
preserved `qualify.ts` is inactive as an operator workflow and is no substitute
launcher. Stop at the cleanup commit handback.

## Historical plan record — superseded, not an actionable checklist

Everything below records the earlier design and implementation sequence. Original
benchmarks, research results and frozen artifacts remain unchanged. Archived
steps are not instructions to create a team, issue receipts, regenerate packages,
run models or hold source integration for the former Task9 live gate. The
[current spec](../specs/2026-09-09-conversation-assessor-reliability-design.md)
and [retained tools](../../experiments/2026-09-09-conversation-assessor-reliability/README.md)
state the narrowed active scope.

**Goal:** Implement bounded, auditable assessment lifecycle and diagnostics, establish the revised benchmark contract, and select a model treatment only after evidence supports it.

**Architecture:** Keep Gauntlet's assessment loop and quorum's role runner. Add assessment-only request control and a completion marker, integrate their consumer and accounting, and prepare one small diagnostic using the existing appliance owner. Lifecycle and scenario work are independent of provider reproduction; the model treatment has an explicit decision gate.

**Tech Stack:** TypeScript, Bun (respect each repository's declared floor), existing pinned Anthropic/OpenAI SDKs, existing obol pricing and appliance ownership.

**Spec:** [Conversation assessor reliability](../specs/2026-09-09-conversation-assessor-reliability-design.md). Read the spec and this plan together.

## Global Constraints

- Offline lifecycle, benchmark, qualification and finite diagnostic implementation is present. Integrated review and a new concrete allocation remain required; no provider execution for this candidate has started.
- Retain the current 120-second outer assessment allowance and existing bounded process cleanup.
- Allocate the final five seconds of that allowance to cooperative cancellation and finalization: the initial work deadline is 115 seconds from the parent's role start.
- The first proposed screen permits at most three logical continuations and three physical HTTP attempts total, whichever limit is reached first. SDK retries consume the same physical-attempt allowance.
- Preserve native report validation, exact criterion count/order, prior-request evidence exposure, derived overall status, ordinary persisted valid-result shape, subject/grader separation and accounting of every attempt.
- Keep generic Gauntlet QA behavior unchanged. Shared client additions are optional for unrelated callers.
- No embedded-prose salvage, majority voting, hidden retry, automatic provider fallback, runtime gold, general replay service, campaign-controller replacement or framework migration.
- Gold, external adjudications and other runs' assessments stay outside grader input. Preserve the assessor's own report/error history except in an explicitly declared diagnostic condition.
- Preserve both stopped operations, historical source/data freezes, raw artifacts and gold. Existing clocks or spend ceilings do not authorize new work.
- Qualification includes the original 18 sessions / 180 judgments, the binding eight-session / 16-judgment supplemental check, the full 12-session driver gate, and then the existing 36-attempt fresh cohort. Additional controls require explicit listing/counting before admission.
- Valid semantic misses fail qualification but permit remaining declared diagnostic assessment sessions. Operational, required-evidence, settled-accounting or ownership failure stops further admission.
- No provider call until an offline-validated caller, immutable inputs and concrete request/time/cost allocation are reviewable and authorized.
- A routine implementation correction within the approved plan does not need its own permission request. Changing model/endpoint, report format, role allowance, benchmark purpose or candidate allocation is a documented scope decision.

---

## Execution map and proof boundaries

Use new paired worktrees named `conversation-assessor-reliability` at execution
time through the worktree skill/native workspace facilities. Start quorum from
the commit containing this plan (spec commit `ae59a833`; runtime code unchanged
from `f48c1f8d83e12416c9d135819178aa0759411aed`), and Gauntlet from
`a9e320fe88b75d16627255540e179dd642f052e0`. Record resolved full SHAs, paths and
clean status. Do not alter old runtime checkouts or install a canonical revision.

In this plan, **Q:** paths are in `superpowers-evals`; **G:** paths are in
`gauntlet`. `D:` means Q's new dated directory
`docs/experiments/2026-09-09-conversation-assessor-reliability/`.
`P:` means the new ignored private directory
`.superpowers/sdd/2026-09-09-conversation-assessor-reliability/`.

Tasks 1 and 2 can run independently. Task 3 consumes both; Task 4 consumes Task 3.
Task 5 consumes Task 2. Task 6 can run alongside those tasks. Task 7 integrates
Tasks 4–6. Task 8 closes offline implementation and prepares execution.
Task 9 is an evidence/authorization gate, not permission to guess a model fix.

| Unit | Files and purpose |
| --- | --- |
| Deadline and terminal primitives | G `src/assessment/lifecycle.ts`, `completion.ts`: deadline derivation, one decision, atomic publication |
| Per-request control | G `src/models/assessment-request.ts`: request-scoped fetch observation, physical attempt bound, cancellation, capture and usage identity |
| Assessment producer | G `src/assessment/assess.ts`, `src/cli/{assess,args}.ts`, `src/index.ts`: lifecycle and completion protocol |
| Live consumer | Q `src/runner/assessment-completion.ts`, `gauntlet-role.ts`, `conversation.ts`: deadline handoff and acceptance |
| Accounting | Q `src/runner/role-usage.ts`: new assessment verifier, legacy verifier unchanged |
| Private reconstruction | D `reconstruct.ts`, `diagnostic.ts`: finite reconstruction/classification, no general service |
| Benchmark | Q `scenarios/conversation-design/story.md`; D `driver/`, `controls.ts`, `benchmark-version.json`: new version and isolated inputs |
| Qualification | Q `src/runner/qualification-set.ts`, `qualification-role.ts`; D `qualify.ts`: shared finite loop/role mechanics and explicit new case set |
| Evidence/readout | D `README.md`, `results.md`, `prepare.ts`, `run.ts`: methodology, freeze and finite owned diagnostic child |

Each code task gets RED/GREEN evidence and a scoped commit, followed by an
independent implementation review during SDD. Tests use synthetic/public inputs
and offline SDK fetches. Run real-model checks only at the declared later gate.

## Task 1: Define deadline decisions and atomic completion publication

**Files:** Create G `src/assessment/lifecycle.ts`,
`src/assessment/completion.ts`, `test/assessment/lifecycle.test.ts`,
`test/assessment/completion.test.ts`. Modify G `src/evidence/writer.ts` only to
add an optional writer callback; its existing default remains unchanged.

**Interfaces:** Export the following from the new assessment modules:

```ts
export type AssessmentDeadline = {
  workDeadlineAtMs: number;
  hardDeadlineAtMs: number;
};
export function assessmentDeadline(input: {
  nowMs: number;
  maxTimeMs: number;
  hardDeadlineAtMs?: number;
}): AssessmentDeadline;
export type AssessmentDecision = {
  kind: "report" | "timed_out" | "cancelled" | "errored";
  atMs: number;
  reason: string;
};
export function createAssessmentDecision(
  workDeadlineAtMs: number,
  now: () => number,
): {
  decide(kind: AssessmentDecision["kind"], reason: string): boolean;
  current(): AssessmentDecision | null;
};
export type AssessmentCompletion = {
  schema_version: 1;
  run_id: string;
  status: "completed" | "timed_out" | "cancelled" | "errored";
  reason: string;
  terminal_at: string;
  accepted_report_sha256: string | null;
};
export function parseAssessmentCompletion(value: unknown): AssessmentCompletion;
export function publishAssessment(input: {
  outDir: string;
  runId: string;
  result: import("../types").VetResult;
  decision: AssessmentDecision;
  beforeMarker(): void;
}): AssessmentCompletion;
```

- **Archived step:** Add boundary tests with an injected clock; include startup consuming the
  allowance, expired inherited work time, zero/NaN/infinite arguments and
  `maxTimeMs <= 5000` rejection. This test is the first RED:

```ts
import { expect, test } from "bun:test";
import { assessmentDeadline, createAssessmentDecision } from "../../src/assessment/lifecycle";

test("startup time is not granted again and stop beats a late report", () => {
  const d = assessmentDeadline({ nowMs: 20_000, maxTimeMs: 120_000, hardDeadlineAtMs: 120_000 });
  expect(d).toEqual({ workDeadlineAtMs: 115_000, hardDeadlineAtMs: 120_000 });
  let now = 114_999;
  const state = createAssessmentDecision(d.workDeadlineAtMs, () => now);
  expect(state.decide("cancelled", "operator cancelled")).toBe(true);
  now = 115_001;
  expect(state.decide("report", "valid native report")).toBe(false);
  expect(state.current()?.kind).toBe("cancelled");
});
```

- **Archived step:** Run `bun test test/assessment/lifecycle.test.ts test/assessment/completion.test.ts`;
  require failure on missing behavior before implementing.
- **Archived step:** Implement the deadline arithmetic below. An inherited deadline that has
  already elapsed is a timed-out run with no request, not a new allowance.
  Anchor subsequent elapsed-time checks to a monotonic clock sampled with the
  initial wall-clock timestamp; parent termination remains the hard backstop.

```ts
const RESERVE_MS = 5_000;
if (!Number.isFinite(input.nowMs) || !Number.isFinite(input.maxTimeMs) ||
    input.maxTimeMs <= RESERVE_MS ||
    (input.hardDeadlineAtMs !== undefined && !Number.isSafeInteger(input.hardDeadlineAtMs))) {
  throw new Error("invalid assessment deadline");
}
const hardDeadlineAtMs = Math.min(
  input.nowMs + input.maxTimeMs,
  input.hardDeadlineAtMs ?? Number.POSITIVE_INFINITY,
);
return { hardDeadlineAtMs, workDeadlineAtMs: hardDeadlineAtMs - RESERVE_MS };
```

- **Archived step:** Implement a single decision latch. At or beyond the work deadline,
  `decide("report", ...)` must select timeout instead of report and return false.
  A selected
  report is provisional until publication succeeds; a writer failure yields
  an errored marker, never a completed marker for partial files.
- **Archived step:** Make `writeResultFiles(outDir, result, writeFile?)` accept an optional
  `(path: string, text: string) => void`; retain `writeFileSync` behavior for
  existing callers. Assessment passes a writer using a unique same-directory
  temporary file, file sync, rename and directory sync. Preserve markdown and
  issue-file generation and all valid-result bytes.
- **Archived step:** Validate completion types, run identity, timestamp and digest/status
  relationship. Serialize/hash the exact final `result.json` bytes. Run
  `beforeMarker()` after report publication and before publishing the marker;
  it seals settled usage/events. Publish the marker once with no overwrite.
  Record `completed` for any valid grade, including fail/unclear; other statuses
  require a null accepted digest.
- **Archived step:** Publish the marker without replacement: sync its complete temporary file,
  atomically link it to the final marker name, then remove the temporary name
  and sync the directory. An existing final name is an error; do not overwrite
  it with rename. Use the same no-overwrite behavior for an errored marker.
- **Archived step:** Add filesystem fault tests: failure before report rename, failure in the
  markdown/issue write, failure sealing evidence, duplicate publication and
  failure publishing the marker. No completed marker may survive an incomplete
  publication. Do not invent a marker if the storage path itself cannot write.
- **Archived step:** Run the focused tests GREEN and existing writer tests; commit these files
  with `Define assessment deadlines and completion publication`.

## Task 2: Add request-scoped cancellation, capture and physical attempt accounting

**Files:** Create G `src/models/assessment-request.ts`,
`test/models/assessment-request.test.ts`. Modify G
`src/models/{provider,anthropic,openai}.ts`, `src/evidence/logger.ts`;
extend `test/models/{anthropic,openai}.test.ts`.

**Interfaces:** Add optional `assessment?: AssessmentRequestControl` to
`RequestContext`. Define these types/functions in `assessment-request.ts`:

```ts
export type AttemptSummary = {
  admitted: number;
  settled: number;
  unknownUsageAttemptIds: string[];
  usage: import("./provider").TokenUsage;
};
export type AssessmentRequestControl = {
  requestId: string;
  signal: AbortSignal;
  workDeadlineAtMs: number;
  now(): number;
  fetch: typeof globalThis.fetch;
};
export type AssessmentAttemptJournal = {
  forRequest(requestId: string, signal: AbortSignal): AssessmentRequestControl;
  snapshot(): AttemptSummary;
  seal(): AttemptSummary;
};
export function createAssessmentAttemptJournal(input: {
  outDir: string;
  provider: import("./provider").Provider;
  model: string;
  workDeadlineAtMs: number;
  now(): number;
  fetch: typeof globalThis.fetch;
  maxPhysicalAttempts?: number;
  captureBodies: boolean;
  logger: import("../evidence/logger").EvidenceLogger;
}): AssessmentAttemptJournal;
```

- **Archived step:** Extend the real-SDK tests with retrying HTTP fixtures: two retryable errors
  followed by one successful response consume all three physical attempts;
  another logical call makes no network request. Use the installed SDK's
  retry-after handling to avoid wall-clock backoff in tests. Add a request aborted
  while fetch is pending and an attempted SDK retry after work expiry.
- **Archived step:** Add a journal-level test without test-only network credentials:

```ts
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EvidenceLogger } from "../../src/evidence/logger";
import { createAssessmentAttemptJournal } from "../../src/models/assessment-request";

test("a refused fourth physical attempt never reaches fetch", async () => {
  const outDir = mkdtempSync(join(tmpdir(), "assessment-attempts-"));
  try {
    let calls = 0;
    const transport = (async () => {
      calls++;
      return new Response("{}", { status: 200 });
    }) as typeof fetch;
    const journal = createAssessmentAttemptJournal({
      outDir, provider: "anthropic", model: "anthropic.claude-sonnet-5",
      workDeadlineAtMs: 115_000, now: () => 0, fetch: transport,
      maxPhysicalAttempts: 3, captureBodies: false,
      logger: new EvidenceLogger(outDir),
    });
    for (let n = 0; n < 3; n++) {
      const request = journal.forRequest("r" + n, new AbortController().signal);
      await request.fetch("http://127.0.0.1/messages", { method: "POST", body: "{}" });
    }
    const fourth = journal.forRequest("r3", new AbortController().signal);
    await expect(fourth.fetch("http://127.0.0.1/messages")).rejects.toThrow();
    expect(calls).toBe(3);
    expect(journal.snapshot().admitted).toBe(3);
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
});
```

- **Archived step:** Run `bun test test/models/assessment-request.test.ts test/models/anthropic.test.ts test/models/openai.test.ts`
  and capture the intended RED.
- **Archived step:** At the fetch boundary, check cancellation, remaining time, journal sealing
  and physical allowance before touching the network. Record admission before
  fetch; share one journal across logical continuations. Assign monotonic attempt
  IDs and logical request IDs; never retry in this wrapper.

```ts
const remainingMs = workDeadlineAtMs - now();
if (sealed || signal.aborted || remainingMs <= 0 ||
    (maxPhysicalAttempts !== undefined && admitted >= maxPhysicalAttempts)) {
  throw new Error("assessment request admission stopped");
}
const attemptId = String(++admitted).padStart(3, "0");
```

- **Archived step:** Construct an SDK client with the request's wrapped fetch only when the
  optional assessment control exists; use existing auth/client options.
  Pass `signal` and the remaining timeout as SDK request options. Keep request
  bodies, tools, model, effort, cache annotations and default SDK retry policy
  unchanged. Avoid mutable global fetch or an ambient current-request variable
  in production; unrelated concurrent clients retain their existing path.
- **Archived step:** Record metadata for every physical request, even with body capture off.
  Use `assessment-attempts.jsonl` with admission/settlement events containing
  `assessment_request_id`, `assessment_attempt_id`, timestamp and outcome.
  Settlement records distinguish response, transport error, aborted, capture
  failure and incomplete. Record usage as recorded, not returned, or invalid;
  distinguish an API error without model content from a model response missing
  required usage. The latter is a settled accounting failure. Unknown invoice
  coverage on the former stays explicit rather than becoming a zero-cost row.
  Allowlist response ID/status/model/stop reason. For diagnostic capture, read a
  cloned response under the same abort/deadline and preserve the original bytes
  for the SDK. Write only request/response bodies, never arbitrary headers or
  credentials. Capture errors are explicit failures, not successful diagnostics.
- **Archived step:** Give the journal sole ownership of assessment usage-row writes, using
  `EvidenceLogger.logUsageRow(rawUsage, identity?)` where optional identity is
  `{ assessment_request_id: string; assessment_attempt_id: string }`.
  Preserve native usage and the existing obol row shape. Factor the existing
  provider token normalization into named pure
  `normalizeAnthropicUsage(raw)` and `normalizeOpenAIUsage(raw)` functions,
  returning `TokenUsage`; reuse them for response conversion and journal totals.
  Do not add a pricing ledger.
- **Archived step:** Capture usage available in any returned physical response, including a
  response whose SDK conversion fails. Record `usage_unavailable` rather than
  assume zero when absent/unparseable. A successful body must not be priced again
  by the assessment loop. Include before/after-abort responses and concurrent
  unrelated client tests. Sealing records still-unsettled attempts as incomplete;
  no event is silently rewritten after the completion marker.
- **Archived step:** Run focused tests GREEN; inspect serialized fixture bodies to prove
  instrumentation did not alter prompts/schema or auth behavior. Commit
  `Observe and bound assessment provider attempts`.

## Task 3: Integrate the assessment lifecycle and CLI protocol

**Files:** Modify G `src/assessment/assess.ts`, `src/cli/assess.ts`,
`src/cli/args.ts`, `src/index.ts`, `test/assessment/assess.test.ts`,
`test/cli/args.test.ts`. Create G `test/assessment/cli-lifecycle.test.ts`.

**Interfaces:** Extend `AssessArgs` with `hardDeadlineAtMs?: number`; add the
assessment-only CLI flag `--hard-deadline-at-ms <integer>`.
Extend `AssessOptions` with optional
`signal?: AbortSignal`, `hardDeadlineAtMs?: number`,
`now?: () => number`, and `attemptJournal?: AssessmentAttemptJournal`.
Keep `runAssessment(options): Promise<VetResult>` and existing valid-result
exit codes.

- **Archived step:** Add failing tests for CLI flag validation, max-time reserve, inherited
  startup delay, zero provider calls when work time already elapsed, cooperative
  timeout/cancel markers, and valid fail/unclear completion. Use synthetic rubric
  and evidence through the real CLI and a localhost-only HTTP server.
- **Archived step:** Add the decisive race tests using the existing assessment fixture, a
  controlled clock/transport and an injectable writer seam from Task 1. Start
  with this concrete decision-boundary test:

```ts
import { expect, test } from "bun:test";
import { createAssessmentDecision } from "../../src/assessment/lifecycle";

test("a timely report decision survives the publication reserve", () => {
  let now = 114_999;
  const state = createAssessmentDecision(115_000, () => now);
  expect(state.decide("report", "valid native report")).toBe(true);
  now = 117_000;
  expect(state.decide("timed_out", "work timer fired")).toBe(false);
  expect(state.current()?.kind).toBe("report");
  expect(state.current()?.atMs).toBe(114_999);
});
```

  Extend the existing filesystem/CLI fixture to delay publication until 117,000,
  verify the persisted result digest and completed marker, then test separate
  cancellation and writer-failure runs. A latch test alone does not establish
  publication or parent-stop correctness.
- **Archived step:** Run `bun test test/assessment/assess.test.ts test/assessment/cli-lifecycle.test.ts test/cli/args.test.ts`
  RED.
- **Archived step:** Parse the new flag only for assess; validate finite safe-integer epoch
  milliseconds. Preserve `--max-time` as the total role allowance and document
  the five-second reserve. In `assess()`, construct one deadline, controller and
  journal before model admission. Register SIGTERM/SIGINT/SIGHUP handlers for
  the assessment command and remove them in finally; leave server/conversation
  shutdown code unchanged.
- **Archived step:** Change report validation to return parsed data without writing. Let the
  loop select one terminal decision, then call `publishAssessment` once.
  Preserve all existing schema/cardinality/reference checks and same-response
  evidence restrictions. Keep full rejected input and failed tool results in
  normal correction history.
- **Archived step:** Pass the request control through the existing `client.chat` fourth
  argument. Set/clear the work-deadline abort timer. Log logical responses once
  and take assessment aggregate tokens from the journal rather than double-add
  returned usage. For injected scripted clients without a journal, preserve
  existing test accounting explicitly; actual CLI always uses the journal.
- **Archived step:** On timeout/cancel, stop admissions immediately and drain observable
  transport settlement during remaining finalization time. Seal the journal and
  run-end before the marker. A transport ignoring abort may prevent cooperative
  completion; parent termination remains the fallback. Preserve returned late
  usage without accepting a late report.
- **Archived step:** Catch request/parse/finalization errors into the operational completion
  path when writable. Never convert an API error into a criterion failure.
  Preserve existing investigate-style empty-criteria timeout output; use marker
  status/reason to distinguish timeout, cancellation and valid uncertainty.
- **Archived step:** Run tests GREEN and existing assessment/report tests. Commit
  `Finalize assessments before the parent deadline`.

## Task 4: Require completion evidence in live quorum and reconcile accounting

**Files:** Create Q `src/runner/assessment-completion.ts`,
`test/assessment-completion.test.ts`. Modify Q
`src/runner/{gauntlet-role,conversation,role-usage}.ts`,
`test/runner-gauntlet-role.test.ts`,
`test/runner-conversation-gauntlet-integration.test.ts`,
`test/runner-conversation.test.ts`. Create Q `test/assessment-accounting.test.ts`.

**Interfaces:** Export from `assessment-completion.ts`:

```ts
export function readAssessmentCompletion(input: {
  outDir: string;
  runId: string;
}): {
  schema_version: 1; run_id: string;
  status: "completed" | "timed_out" | "cancelled" | "errored";
  reason: string; terminal_at: string;
  accepted_report_sha256: string | null;
};
export function applyAssessmentStop(
  existing: "cancelled" | "timed_out" | null,
  child: "completed" | "timed_out" | "cancelled" | "errored",
): "cancelled" | "timed_out" | null;
```

Export `verifyAssessmentAccounting` from `role-usage.ts`, taking
`{ runJsonl: string; usageJsonl: string; attemptsJsonl: string }` and returning
`{ logicalResponses: number; physicalAttempts: number; unknownUsageAttemptIds: string[] }`.
Throw on duplicate/missing identity links or malformed known usage. It must allow
an honest zero-response interrupted assessment; it does not declare qualification
complete merely because incomplete coverage is accurately described.

- **Archived step:** Write failing tests for missing/wrong-version/wrong-run markers, digest
  mismatch, valid fail/investigate reports, child cooperative timeout, and parent
  cancellation winning over a completed marker.

```ts
import { expect, test } from "bun:test";
import { applyAssessmentStop } from "../src/runner/assessment-completion";

test("a completed child cannot undo an existing parent stop", () => {
  expect(applyAssessmentStop("cancelled", "completed")).toBe("cancelled");
  expect(applyAssessmentStop(null, "timed_out")).toBe("timed_out");
  expect(applyAssessmentStop(null, "completed")).toBeNull();
});
```

- **Archived step:** Run `bun test test/assessment-completion.test.ts test/assessment-accounting.test.ts test/runner-gauntlet-role.test.ts`
  RED.
- **Archived step:** In `invokeGauntletRole`, compute the assessment role's start/deadline once
  immediately before spawn, append the inherited hard-deadline flag, and arm
  the parent timer from the same origin. Reject a conflicting supplied flag.
  Leave conversation arguments, tmux ownership and bounded kill cleanup intact.
- **Archived step:** Validate the child marker only after child settlement and before accepting
  its report. Enforce all Task 1 fields and hash the exact result bytes.
  Apply stop causes without clearing an existing stop:

```ts
return existing ?? (
  child === "timed_out" ? "timed_out" :
  child === "cancelled" ? "cancelled" : null
);
```

- **Archived step:** Keep nonzero exit semantics distinct: a valid semantic fail/unclear
  assessment can exit 1 and be structurally completed. Missing marker, errored
  marker, inconsistent result or unclosed process remains operational failure.
  Historical renderers do not require new markers or backfill them.
- **Archived step:** Add the new assessment accounting verifier over admission/settlement IDs
  and usage-row identities. Keep `verifyReturnedTurns` unchanged for legacy and
  driver records. Reconcile known subtotals through existing obol pricing even
  on failure; preserve unknown coverage rather than manufacture zero.
- **Archived step:** Exercise the actual paired CLI with delayed/hung localhost responses,
  late valid report publication, SIGTERM, forced kill and storage failure.
  Assert every failed path retains the parent role record and cannot become pass.
- **Archived step:** Run focused tests GREEN, then
  `GAUNTLET_ROOT=<absolute-new-G-worktree> bun test test/runner-conversation-gauntlet-integration.test.ts`.
  Resolve the absolute worktree value from the recorded execution map; do not
  point this test at a live endpoint. Commit `Require assessment completion evidence in quorum`.

## Task 5: Build the offline reconstruction and finite diagnostic

**Files:** Create D `reconstruct.ts`, `diagnostic.ts`;
Q `test/assessment-reconstruction.test.ts`,
`test/assessment-diagnostic.test.ts`. Private outputs:
P `reconstruction.json`, `reconstruction-review.json`, `diagnostic-proposal.json`.

**Interfaces:**

```ts
export type ReconstructedRequest = {
  schemaVersion: 1;
  label: "logical-prefix-reconstruction";
  source: { qSha: string; gSha: string; sdkVersion: string };
  model: string;
  endpoint: string;
  body: Record<string, unknown>;
  bodySha256: string;
  sourceRefs: { path: string; sha256: string }[];
};
export function reconstructAssessmentPrefix(input: {
  runJsonl: string;
  readArtifact(path: string): string;
  requestTurn: number;
  serialize(messages: unknown[], tools: unknown[], system: string): Record<string, unknown>;
  source: ReconstructedRequest["source"];
  model: string;
  endpoint: string;
}): ReconstructedRequest;
export function classifyDiagnosticResponse(input: {
  sdkContent: unknown;
  arguments: unknown;
  criterionCount: number;
  exposedPaths: Set<string>;
  validate(arguments: unknown, count: number, paths: Set<string>): { ok: boolean; reason?: string };
}): { kind: "valid_report" | "invalid_report" | "non_report"; reason: string };
```

- **Archived step:** Write tests for spilled evidence expansion, ordered tool/result pairing,
  preserved opaque thinking blocks/signatures, excluded other-run judgments,
  missing artifact rejection and source/hash mismatch. Include this test for
  the classifier's no-salvage boundary:

```ts
const result = classifyDiagnosticResponse({
  sdkContent: [],
  arguments: { summary: "x", reasoning: 'x</reasoning><criteria>[]</criteria>' },
  criterionCount: 3,
  exposedPaths: new Set(),
  validate: (args) => ({
    ok: Array.isArray((args as { criteria?: unknown }).criteria),
    reason: "missing native criteria",
  }),
});
expect(result.kind).toBe("invalid_report");
```

- **Archived step:** Run `bun test test/assessment-reconstruction.test.ts test/assessment-diagnostic.test.ts`
  RED.
- **Archived step:** Reconstruct the latest turn-8 input from the retained source/events.
  Preserve exact delivered evidence wrappers, intact opaque blocks and the
  first system/tool descriptions. Resolve only authenticated local spill paths.
  Treat absent information as reconstruction failure; never infer hidden text.
- **Archived step:** Obtain serialization from the actual pinned SDK through a network-disabled
  fetch interceptor, using frozen G `a9e320fe` behavior. Compare the diagnostic
  adapter's serialized body to that reconstruction, excluding nothing silently.
  Instrumentation must not introduce new system instructions, schema order,
  effort, thinking or cache changes. Record that historical HTTP bytes are unknown.
- **Archived step:** Implement a callable diagnostic function that uses the Task 2 journal,
  keeps the native SDK/adapter/HTTP boundaries distinct and never dispatches
  returned tools. Map exceptions separately to API error, capture failure,
  timeout and incomplete; classify bad cardinality/other invalid reports without
  rescuing their contents.

```ts
for (let continuation = 1; continuation <= 3; continuation++) {
  if (journal.snapshot().admitted >= 3 || signal.aborted) break;
  await observeOneContinuation(continuation);
}
```

  Define `observeOneContinuation(n): Promise<void>` inside the diagnostic
  function: create logical request ID, call the pinned adapter once, persist its
  response/classification or explicit error and return without correction.
  HTTP retries remain exclusively the SDK's behavior and consume the shared cap.
- **Archived step:** Add an offline CLI preparation mode which requires no credentials and
  cannot enable network. It emits the private source/input/request freeze and
  proposed three-attempt screen. The live function is only invoked by an
  authorized appliance-owned caller after its immutable proposal is authenticated.
- **Archived step:** Test early API errors, SDK retries, no-tool responses, truncation, captured
  usage plus conversion failure and journal exhaustion. Nothing retries until
  favorable output; zero reproduction ends the screen as inconclusive.
- **Archived step:** Run tests GREEN, produce the reconstruction review artifact and commit
  portable code/tests as `Prepare bounded assessment reproduction`. Private
  bodies/gold remain ignored.

## Task 6: Version the scenario and freeze independent semantic controls

**Files:** Modify Q `scenarios/conversation-design/story.md`,
`test/conversation-routine-use-cases.test.ts`.
Create D `benchmark-version.json`, `controls.ts`,
`driver/briefs/preferences.md`, `driver/cases.ts`,
`driver/expected.md`; Q `test/assessment-reliability-controls.test.ts`.
Reuse the existing controlled subject and the other five driver situations.
Modify G `src/conversation/converse.ts` only if controlled evidence identifies
a generic instruction gap; do not insert watching-specific language there.

**Interfaces:** `loadSupplementalControls(root, receiptPath)` in D
`controls.ts` returns
`{ id: string; rubricPath: string; evidenceRoot: string; evidenceIndexPath: string; expected: ("pass"|"fail"|"unclear")[] }[]`.
Only the caller receives expected values. Pass to Gauntlet only each rubric and
its indexed evidence paths.

- **Archived step:** Add failing fixture tests for input isolation and exact receipt-bound
  bytes. Validate that broad and narrow scripted-user cases cover distinct acts,
  rather than asserting a model will obey particular prompt text.
- **Archived step:** Run `bun test test/assessment-reliability-controls.test.ts test/conversation-routine-use-cases.test.ts`
  RED.
- **Archived step:** Use this proposed revised opening request, preserving discussion-before-code:

```text
I'd like task completion notifications on this Tasks page, but I only care
about notifications for some tasks. Before writing any application code,
can you help me settle the important choices and give me a short proposal?
```

  Keep local-browser/in-page preferences and the existing delivery endpoint.
  Require the driver to answer broad relevant preference/scope questions and
  decline an offered choice inconsistent with the brief. Task-population-only
  questions do not obligate unrelated disclosures. Record that the cue changes
  what the task reveals; do not call the revision lossless.
- **Archived step:** Write a benchmark manifest binding prior/new story hashes, explicit
  semantic delta, rubric/mapping identities, driver fixture versions and
  unchanged historical corpus identity. Update the new preference brief and
  expected permissible acts; reuse unchanged five driver cases and the existing
  subject sequence without looping it until success.
- **Archived step:** Authenticate
  `heldout-freeze-receipt.json` under the prior repair private directory and its
  exact `heldout-v2/manifest.json` binding. Use the separate approved receipt,
  not the manifest's historically unchanged pre-review flags. Verify all eight
  cases, 16 criteria, evidence paths and expectation digests before returning
  controls.
- **Archived step:** Independently map the spec's semantic obligations to the retained corpus
  and eight controls. Freeze concrete all-tasks-agreement and unsupported-default
  counterexamples if coverage is missing, using a fresh author/reviewer before
  candidate outputs. Any added live cases must be explicitly listed with
  criterion count and independent gold in the later execution proposal; the
  fixed eight are never silently replaced or relabeled.
- **Archived step:** Confirm the model-input projection contains no expectation files, manifest
  commentary, prior adjudications or source-review records:

```ts
const input = { rubricPath: c.rubricPath, evidenceRoot: c.evidenceRoot, evidenceIndexPath: c.evidenceIndexPath };
expect(Object.keys(input).sort()).toEqual(["evidenceIndexPath", "evidenceRoot", "rubricPath"]);
```

  Pair this projection check with the actual scoped reader's existing no-parent/
  no-unindexed-path tests; key shape alone does not prove read isolation.
- **Archived step:** Run focused tests GREEN and `bun run quorum check`; regenerate manifests
  only if the deterministic check vocabulary changes (this story edit should
  not require it). Commit `Version selective notification scenario and controls`.

## Task 7: Integrate finite qualification and honest readout

**Files:** Create Q `src/runner/qualification-set.ts`,
`src/runner/qualification-role.ts`,
D `qualify.ts`, `README.md`, `results.md`;
Q `test/assessment-reliability-qualification.test.ts`.
Modify Q `docs/experiments/2026-09-08-conversation-routine-use/qualify.ts` to
delegate shared loop/role mechanics while preserving its original schedule,
input loader and API. Extend `test/conversation-routine-use-operator.test.ts`.

**Interfaces:** Move/re-export the existing settlement type without changing it.
Export these interfaces from the new shared modules:

```ts
export type QualificationSettlement = {
  knownUsd: number; complete: boolean; semanticMatch: boolean; fault: string | null;
};
export type QualificationSession = {
  id: string; repetition: number; group: "retained" | "supplemental" | "driver";
};
export function runQualificationSessions(d: {
  sessions: QualificationSession[];
  outputRoot: string;
  now(): number;
  fits(): boolean;
  stopped(): boolean;
  validate(): void;
  execute(session: QualificationSession, out: string): Promise<QualificationSettlement>;
}): Promise<QualificationSettlement & { consumed: number }>;
export type QualificationRoleInput =
  | { kind: "assessment"; rubricPath: string; evidenceRoot: string;
      evidenceIndexPath: string; expected: ("pass"|"fail"|"unclear")[];
      groups: { originalOrdinal: number; atomicOrdinals: number[] }[];
      originalVerdicts: ("pass"|"fail"|"unclear")[] }
  | { kind: "driver"; briefPath: string; subjectScriptPath: string;
      subjectCase: string; expectedCompletion: "delivery"|"refusal" };
export function executeQualificationRole(input: {
  gRoot: string; runDir: string; model: "anthropic.claude-sonnet-5";
  env: Record<string, string | undefined>;
  stopped(): boolean;
  role: QualificationRoleInput;
}): Promise<QualificationSettlement>;
```

Preserve original 18/12 wrapper schedules. D `qualify.ts` constructs the new
schedule and maps each authenticated input to `QualificationRoleInput`.
Keep the old nine-case loader fixed; do not teach it to accept supplemental
cases. Supplemental cases use Task 6's loader, with identity original-fold
groups (each criterion maps to itself). The shared worker receives expectations
for comparison but sends only rubric/evidence paths to Gauntlet. New driver
cases supply the versioned preference brief and reuse the unchanged subject
script/other five situations.

- **Archived step:** Add failing tests with injected settlement values for 18 retained plus
  eight supplemental sessions, per-group denominators, operational stop and
  semantic misses continuing all remaining declared assessments.

```ts
const assessmentSchedule = [
  ...retainedIds.flatMap(id => [1, 2].map(repetition => ({ id, repetition, group: "retained" as const }))),
  ...supplementalIds.map(id => ({ id, repetition: 1, group: "supplemental" as const })),
];
expect(assessmentSchedule.filter(s => s.group === "retained")).toHaveLength(18);
expect(assessmentSchedule.filter(s => s.group === "supplemental")).toHaveLength(8);
```

  `retainedIds` comes from the unchanged nine-case catalogue;
  `supplementalIds` comes from Task 6's authenticated eight controls.
- **Archived step:** Run `bun test test/assessment-reliability-qualification.test.ts test/conversation-routine-use-operator.test.ts`
  RED.
- **Archived step:** Move only the reusable serial-loop mechanics, preserving launch and
  settlement records, validate-before-admit, stopped/fit checks, known-cost
  accumulation and failure distinction. Keep old dated inputs/envelopes/
  registrations frozen. Extract the existing role callback's mechanical setup,
  invocation, result/exit validation and cost retention into
  `executeQualificationRole`; old and new wrappers resolve their own policies
  and inputs before calling it. This avoids copying the large old callback for
  supplemental cases. Do not fork a controller or general recovery API.
- **Archived step:** Use the new assessment completion/accounting checks for the revised
  candidate. Bind supplemental rows to their own expected vectors; retained
  rows still require original folds and all 180 atomic judgments.
- **Archived step:** Produce a private rationale-review input binding every accepted result,
  evidence and expectation digest. Qualification cannot pass until independent
  review confirms decisive reasoning. Persist that receipt before driver
  admission; automatic vector equality is insufficient. Do not evaluate
  malformed drafts as accepted semantic results.
- **Archived step:** Gate the driver on both assessment groups being complete and correct;
  gate the 36-attempt fresh campaign on the complete 12-session driver review.
  Version the fresh cohort's scenario inputs and avoid comparing mixed benchmark
  versions as one treatment effect.
- **Archived step:** Record first-report validity, eventual report completion, logical and
  physical attempts, corrections, accepted semantic agreement, overall correct
  sessions, latency and known/unknown cost. Zero accepted reports yields an
  undefined semantic rate, not zero or perfect accuracy. Failed reports and
  interrupted requests remain in overall denominators.
- **Archived step:** Run tests GREEN and verify the old qualification wrapper's 18/12 behavior
  remains unchanged. Commit `Qualify revised assessments with separate control denominators`.

## Retired Tasks 8 and 9: bespoke execution and launch gate

These tasks are cancelled by the user override. The original interface, parent/
child launcher, authority/relocation provisioning, package and provider-screen
instructions remain only in Git/private historical evidence. They are not an
implementation backlog or an execution gate for merging useful source changes.
No unchecked item, old dispatch or unapproved package may resume them.

## Archived plan self-review and handoff (inactive)

Coverage: diagnosis/reconstruction Tasks 2/5/8/9; deadlines and marker Tasks 1/3/4;
request accounting Tasks 2/4/7; benchmark and semantic controls Task 6; independent
rationale/driver/campaign gates Tasks 7/9; source verification and ownership
Task 8; preserved historical state applies globally.

Execute approved offline work with SDD and independent task reviews, consistent
with the user's original workflow preference. Use the existing paired source
boundaries; no new team research is required to begin these specified tasks.
Provider work and the model-treatment continuation remain at their explicit
evidence and allocation gates. This document itself launches nothing.
