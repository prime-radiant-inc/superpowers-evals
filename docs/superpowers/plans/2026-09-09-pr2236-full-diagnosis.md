# PR 2236 Full Diagnosis Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prepare the six-run full-diagnosis comparison, qualify its evidence
and accounting offline, and produce a concrete launch packet for the next paid
pilot; execute and record that pilot after its spending allowance is authorized.

**Architecture:** Extend the existing Quorum scenario and campaign approach with
native incident fixtures, source-preserving ATIF capture, and private offline
report assessment. Keep historical sessions, new diagnosis analysts, and the
Gauntlet-Agent distinct. Reuse the appliance's finite execution and publication
contracts.

**Tech Stack:** TypeScript, Bun >=1.3, existing ATIF v1.7 normalizers and obol
pricing, shell scenario DSL, YAML arm/suite declarations.

**Spec:** [Full diagnosis pilot](../specs/2026-09-09-pr2236-full-diagnosis-design.md).

## Global Constraints

- "Use **six top-level runs**: one before/after pair per harness, one incident per pair, no repetitions or reserve."
- "Each run must dispatch all seven analysts: **42 expected analyst invocations**"; count unexpected additional work too.
- "Quorum normalizes those sources to ATIF at its existing boundary; assessment logic and token/time calculations consume ATIF."
- "No new per-harness raw-log behavior, token, or timestamp parsers belong in the assessment layer."
- "Keep the answer key and assessment artifacts outside all Coding-Agent and Gauntlet-Agent mounts."
- "A timeout or setup failure consumes the attempt; no automatic rerun, rescue, or extra analyst retry is scheduled by the test driver."
- "The earlier discovery allowance does not carry forward automatically."
- "Missing or unpriced child usage is not zero."
- "Leave the old pilot keys and published results intact."
- Models and supported effort stay as specified: Claude `opus_bedrock`/high,
  Codex `openai_responses_56sol`/high, Pi `pi_gpt56_sol`/no override,
  Gauntlet-Agent `sonnet5`/`claude-sonnet-5`.
- The runtime control is `d7bc5b0197d3f5358d8af03d4474ec3c826465be`; the runtime
  treatment is `6ac8f0c0c9e256a619736388fd5c0b85c35c39a1`. Their source commits
  are `801badbf719f4044c97175e5b01fb6f7cbc32c2d` and
  `3f0a63e860d4719397e584e90cc7af07a247cb6d` respectively.
- Fifteen-minute scenario limit; 1,200-second outer attempt limit;
  `n: 1`, `reserve: 0`, `max_attempts: 1`, global cap two.
- Scope ends at the local diagnosis report. No issue searches/publication,
  export, similar-session search, skill fixes, or extra harnesses.

## Execution context and boundaries

Continue in `/Users/drewritter/.paseo/worktrees/1miz249l/pr2236-session-discovery`
on `codex/pr2236-session-discovery`. The sibling Superpowers worktree is
`/Users/drewritter/.paseo/worktrees/2mmrq9t5/pr2236-shared-discovery`. Verify
their state; do not recreate them or modify the original checkout's unrelated
`test/conversation-reliability-operator.test.ts`.

Use inline execution by default, following executing-plans. Routine task
implementation and offline qualification do not need another permission check.
Tasks 1–5 prepare reviewable artifacts; Task 6's live launch depends on a new
explicit spending allowance. Do not ask for that allowance before Task 5 has
produced actual qualified inputs and an estimate. Read the experiment logs
linked by the spec before changing methodology.

Create private preparation storage at
`/Users/drewritter/.local/share/superpowers-evals/pr2236-full-diagnosis-20260909`.
Keep original native evidence, transformed live fixtures, answer keys, and
assessments there. The public implementation branch contains code, synthetic
unit fixtures, and scenario instructions, not native incident data. Task 5
stages the reviewed native fixture bytes in a private Evals runtime commit for
the appliance. Never push that runtime branch or merge it into the public
implementation branch. No new fixture packaging service is needed.

Existing seams verified during planning:

- Setup precedes `snapshotDir`, so preinstalled histories are excluded from new
  Coding-Agent usage. Preserve that ordering.
- `ATIF_NORMALIZERS` is exported by `src/capture/index.ts`. The normalizers
  already return ATIF, preserve usage on steps, and canonicalize dispatches to
  `Agent` with `arguments.prompt` where supported.
- `captureToolCalls` normalizes each new file, but currently keeps only the
  merged trajectory. Its private `mergeTrajectories` renumbers step ids.
- The Claude normalizer deduplicates native UUIDs and bundles `message.id`;
  Pi splits assistant tool blocks; Codex retains separate usage observations.
  Source locations must survive those operations without duplicating charges.
- Cwd filtering exists for Codex and Pi. Do not remove it globally to find
  children; qualify the configured native child layout and exact ownership.
- `runScenario` has one final publication path after normal returns and caught
  errors. Its `provenanceRunHome` resolves both local and campaign attempt homes.
  `writeAttemptManifest` excludes the top-level `home` directory. Artifacts left
  only in that home will not be published.
- `session-discovery-fixtures.ts` requires exactly three JSONL files. Leave its
  old API and evidence semantics intact; this fixture set includes four sessions
  and may also need native relationship sidecars and historical plan files.

## File map and dependency order

| Task | Files and responsibility |
|---|---|
| 1 | New `src/experiments/diagnosis/contracts.ts`, `fixtures.ts`, and `src/cli/diagnosis-fixtures.ts`: neutral fixture manifest, installation, preservation checks; private corpus and key. |
| 2 | New `src/atif/provenance.ts`, `src/capture/source-index.ts`; modify `src/normalize/{claude,codex,pi}.ts`, `src/capture/index.ts`: source locations and per-session ATIF retention. |
| 3 | New `src/experiments/diagnosis/artifacts.ts`; modify finalization in `src/runner/index.ts`; new `scenarios/diagnosing-full-session/`: scoped artifact retention and full report request. |
| 4 | New `src/experiments/diagnosis/assessment.ts`, `src/cli/diagnosis-assessment.ts`: private extraction/review contract, deterministic checks, reproducible readout. |
| 5 | New six `arms/pr2236_full_{claude,codex,pi}_{before,after}.yaml`, `suites/pr2236_full_diagnosis.yaml`, config tests, experiment entry; private runtime and launch packet. |
| 6 | Private campaign evidence and assessments; update the new experiment entry with all six outcomes and costs. |

Each task carries its own tests and commit. Tasks 1–5 are sequential: fixture
facts inform normalization, which informs collection and assessment. Task 6
does not begin merely because the plan has been written.

### Task 1: Qualify the incident corpus and install its neutral files

**Files:** Create `src/experiments/diagnosis/contracts.ts`,
`src/experiments/diagnosis/fixtures.ts`, `src/cli/diagnosis-fixtures.ts`, and
`test/diagnosis-fixtures.test.ts`. Private deliverables: `corpus/`, `keys/`,
`corpus-review.md`, and `public-requests.json` under the preparation root.

**Interfaces:** Define the types below in `contracts.ts`; implement the two
exported functions in `fixtures.ts`. Reuse the types in all later tasks. Runtime
validation uses zod with strict objects, normalized relative paths, nonempty ids,
finite numbers, positive integer lines, and SHA-256 syntax.

```ts
export type DiagnosisHarness = 'claude' | 'codex' | 'pi';
export const DIMENSIONS = [
  'skill-timeline', 'plan-adherence', 'repeated-work', 'stumbles',
  'quality-evidence', 'request-conflicts', 'cost-and-time',
] as const;
export type Dimension = (typeof DIMENSIONS)[number];
export interface NativeLocator { source: string; line: number }
export interface FixtureFile {
  path: string; // relative to the corpus directory
  destination: 'session-store' | 'workdir';
  relativePath: string; // under that destination
  sha256: string;
}
export interface FixtureManifest {
  schemaVersion: 1;
  harness: DiagnosisHarness;
  files: FixtureFile[]; // no target/child/decoy labels
}
export interface ExpectedFinding {
  id: string;
  dimension: Dimension;
  statement: string;
  evidence: NativeLocator[];
}
export interface ExpectedQuantity {
  id: string;
  value: number | null; // null means evidenced unavailable, never zero
  unit: 'tokens' | 'ms' | 'bytes' | 'count';
  scope: string; // stable turn/session/result identifier in the key
  evidence: NativeLocator[];
}
export interface DiagnosisKey {
  schemaVersion: 1;
  harness: DiagnosisHarness;
  manifestSha256: string;
  sessions: Array<{
    id: string; role: 'root' | 'child' | 'decoy'; source: string;
    parentId: string | null; evidence: NativeLocator[];
  }>;
  humanTurns: Array<{
    id: string; text: string; timestamp: string | null;
    evidence: NativeLocator[];
  }>;
  requiredFindings: ExpectedFinding[];
  negativeControls: ExpectedFinding[]; // statements describing correct behavior
  quantities: ExpectedQuantity[];
  capabilities: Record<string, { available: boolean; evidence: NativeLocator[] }>;
}
export interface FixtureArgs {
  manifest: FixtureManifest; corpusDir: string; home: string; workdir: string;
}
export interface FilePreservation {
  source: string; installedPath: string; expectedSha256: string;
  actualSha256: string | null; status: 'unchanged' | 'changed' | 'missing';
}
// Public API implemented by fixtures.ts:
export function installDiagnosisFixture(args: FixtureArgs): void;
export function verifyDiagnosisFixture(args: FixtureArgs): FilePreservation[];
```

- [ ] **Inventory retained incidents.** Start with local retained runs and the
  private discovery evidence; follow their documented run pointers to read-only
  appliance artifacts if needed. List files and sizes first. Normalize candidate
  roots and children through `ATIF_NORMALIZERS` for an initial inventory, then
  independently inspect bounded native records for the spec's preferred
  three-to-eight human prompts (a complete two-prompt task is acceptable),
  at-most-forty tool calls, agreement, observed behavior, child linkage,
  usage/timing evidence, and negative control. A normalized inventory is not the
  independent answer key. Record rejected candidates and missing properties.
  Clean incidents may supply negative controls; never invent a deviation to
  make a retained history qualify.
- [ ] **Freeze three eligible incidents.** Retain one root, one linked child,
  two decoys, and necessary native relationship sidecars/artifacts per harness.
  Preserve a complete selected task, counter baselines, and real plan output.
  Record every sanitization/path transformation and original/transformed hashes.
  Do not generate native events or a prose plan to fill a missing incident.
  If a harness has no qualifying retained incident, report its exact gap and a
  separately counted generation proposal; continue independent code tasks using
  synthetic unit data, but do not declare the live corpus qualified.
- [ ] **Write the private truth and public request.** Fill `DiagnosisKey` using
  literal facts checked against native locators. Include token counter meanings,
  turn endpoints, complete human-prompt order, expected top lists, and unavailable
  fields. The public request supplies remembered time/task, expectation, symptom,
  and report scope only. Store the final verbatim request and neutral answers in
  `public-requests.json`; no runtime answer-key mount.
- [ ] **Write installation/preservation tests.** Unit data is explicitly
  synthetic and tests byte copying, not native behavioral realism. In a temp
  home, provide four neutral JSONL files, one relationship sidecar, and a plan
  artifact. Assert all six reach their declared destinations, with no answer
  labels or precomputed case file added. Core regression:

  ```ts
  import { expect, test } from 'bun:test';
  import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
  import { tmpdir } from 'node:os';
  import { join } from 'node:path';
  import { createHash } from 'node:crypto';
  import { installDiagnosisFixture, verifyDiagnosisFixture }
    from '../src/experiments/diagnosis/fixtures.ts';
  import type { FixtureArgs } from '../src/experiments/diagnosis/contracts.ts';

  test('retains four histories and detects changed installed bytes', () => {
    const root = mkdtempSync(join(tmpdir(), 'diagnosis-unit-'));
    const corpusDir = join(root, 'corpus');
    mkdirSync(corpusDir);
    const body = '{"unit_fixture":true}\n';
    const sha256 = createHash('sha256').update(body).digest('hex');
    const files = ['a', 'b', 'c', 'd'].map((id) => {
      const path = `${id}.jsonl`;
      writeFileSync(join(corpusDir, path), body);
      return { path, destination: 'session-store' as const,
        relativePath: path, sha256 };
    });
    const args: FixtureArgs = {
      manifest: { schemaVersion: 1, harness: 'pi', files }, corpusDir,
      home: join(root, 'home'), workdir: join(root, 'workdir'),
    };
    installDiagnosisFixture(args);
    const rows = verifyDiagnosisFixture(args);
    expect(rows).toHaveLength(4);
    expect(rows.every((row) => row.status === 'unchanged')).toBe(true);
    const installed = rows[0]!.installedPath;
    expect(readFileSync(installed, 'utf8')).toBe(body);
    writeFileSync(installed, 'changed\n');
    expect(verifyDiagnosisFixture(args)[0]!.status).toBe('changed');
  });
  ```

  Add refusal tests for `..`, absolute destinations, duplicate destinations,
  source/destination symlinks, hash mismatch, overwrite, and unsupported harness.
  Register temp-directory cleanup in the test file.
- [ ] **Run RED.** `bun test test/diagnosis-fixtures.test.ts`; expect the new
  module/API absence to fail before implementing it.
- [ ] **Implement byte-only installation.** Validate the whole manifest and
  all source hashes before copying anything. Use the existing three harness
  store roots from the discovery installer, `COPYFILE_EXCL`, regular-file and
  containment checks. Workdir artifacts retain reviewed neutral names. Neither
  installer nor verifier parses transcript semantics. Reuse small existing
  helpers where practical without changing the old three-file default.
  CLI: `install <manifest> <corpus-dir>` and `verify <manifest> <corpus-dir>`.
  Resolve install home from `QUORUM_CODING_AGENT_HOME`; resolve check home from
  validated `QUORUM_AGENT_CONFIG_DIR`, as the existing discovery CLI does.
  `verify` returns 1 for changed/missing subject files; malformed inputs or
  unreadable reference data return 127.
- [ ] **Run GREEN and commit.** Run the new tests plus
  `bun test test/session-discovery-fixtures.test.ts`. Commit the new code and
  synthetic tests as `Add full-diagnosis fixture installation and preservation checks`.
  Keep live corpus/key files private and retain their qualification status.

### Task 2: Preserve source evidence through ATIF normalization and capture

**Files:** Create `src/atif/provenance.ts`, `src/capture/source-index.ts`,
`test/atif-provenance.test.ts`, `test/capture-source-index.test.ts`. Modify
`src/normalize/claude.ts`, `codex.ts`, `pi.ts`, `src/capture/index.ts`, and their
existing `test/normalize.{claude,codex,pi}.test.ts`/`test/capture.test.ts` tests.

**Interfaces:** Keep the existing normalizer signatures and `CaptureResult`
fields. Store source metadata under ATIF `extra.quorum_source`; retain existing
extras, cache buckets, timestamps, tool names, and message content.

```ts
// src/atif/provenance.ts
export interface NativeEvidence {
  lines: number[]; // 1-based source lines; retain all contributors to a bundle
  origin?: 'human' | 'injected' | 'parent' | 'unknown';
  timestamp?: string; // original result/usage boundary when applicable
  contentBytes?: number; // native tool-result content, before display decoration
}
export function withNativeEvidence(
  extra: Record<string, unknown> | undefined, evidence: NativeEvidence,
): Record<string, unknown> {
  return { ...extra, quorum_source: evidence };
}

// src/capture/source-index.ts
export interface CapturedSource {
  id: string; nativePath: string; sha256: string;
  trajectoryPath: string | null; // relative to runDir; null on normalization error
  error: string | null;
}
export interface SourceIndex {
  schemaVersion: 1;
  sources: CapturedSource[];
  mergedSteps: Array<{
    mergedStepId: number; sourceId: string; sourceStepId: number;
  }>;
}
```

- [ ] **Write normalizer provenance regressions.** Use the existing native unit
  fixtures and small explicitly synthetic records. Require call, result, and
  usage locators to refer to their actual different source lines; blank and
  malformed skipped lines must not shift later locators. Verify Claude bundled
  messages retain all contributing lines while duplicate UUID replay is not
  billed again; Pi split tool steps share the assistant line while usage occurs
  once; Codex repeated usage snapshots preserve the supported request totals.
  For each normalizer, keep the expected facts literal in the test.

  ```ts
  import { expect, test } from 'bun:test';
  import { normalizePi } from '../src/normalize/pi.ts';

  test('Pi result keeps its own line, time, and content size', () => {
    const raw = [
      { type: 'session', id: 'unit-session' },
      { type: 'message', timestamp: '2026-09-01T00:00:01Z', message: {
        role: 'assistant', content: [{ type: 'toolCall', id: 'call-1',
          name: 'bash', arguments: { command: 'true' } }],
      } },
      { type: 'message', timestamp: '2026-09-01T00:00:02Z', message: {
        role: 'toolResult', toolCallId: 'call-1', toolName: 'bash',
        content: [{ type: 'text', text: 'ok' }],
      } },
    ].map((entry) => JSON.stringify(entry)).join('\n');
    const step = normalizePi(raw, 'unit').steps[0]!;
    expect(step.timestamp).toBe('2026-09-01T00:00:01Z');
    expect(step.extra?.quorum_source).toMatchObject({ lines: [2] });
    expect(step.observation!.results[0]!.extra?.quorum_source).toMatchObject({
      lines: [3], timestamp: '2026-09-01T00:00:02Z', contentBytes: 2,
    });
  });
  ```

- [ ] **Run RED, then attach provenance at emission sites.** Run
  `bun test test/atif-provenance.test.ts test/normalize.claude.test.ts test/normalize.codex.test.ts test/normalize.pi.test.ts`.
  Index raw lines before parsing/deduplication. Carry line numbers alongside
  native entries rather than inserting fields into the native objects. Set
  step/call/observation/metrics extras at the code that emits or attaches those
  values. Preserve usage-record timestamps in metrics provenance without
  replacing call timestamps. Measure UTF-8 result content before normalizer
  decoration; account for actual text blocks without counting the JSON envelope.
  Unknown non-text size remains unavailable, not zero.
- [ ] **Preserve identity and author provenance where evidenced.** Keep native
  session metadata needed to link parent dispatches and children in trajectory
  extras. Add observed child ids/paths to canonical `Agent` call/result extras
  at the normalizer boundary. Distinguish a fork relationship from a spawned
  analyst. Set author origin only when native evidence establishes it; use
  `unknown` otherwise. A child role established by the source relationship
  changes interpretation of its user messages, not their original ATIF `source`.
  Private fixture qualification must prove the required historical roles;
  no report checker may infer them from a harness-specific JSON field.
- [ ] **Write capture retention regressions.** In a temporary log directory,
  snapshot one seeded history, then add a root and child with overlapping times.
  Assert both new per-file trajectories exist, each merged step maps to the
  correct source/id, the seed is excluded, and pricing the merged trajectory
  counts root and child once. A tool-less child with usage is still retained.
  Test one failed normalization, a retry after files change, and zero-row capture
  so stale indexes/trajectories cannot survive.
- [ ] **Run RED and implement capture retention.** Run
  `bun test test/capture-source-index.test.ts`. Read each selected raw file once,
  hash those bytes, normalize them, and write successful per-file ATIF to
  `atif-sources/000001.json`, etc. Record failed sources explicitly. Change the
  private merge result to include the source-step mapping while preserving the
  existing merged `trajectory.json` and pricing path. Write `atif-sources.json`
  only after the matching per-source files; rebuild that capture-owned directory
  on retries. Ordinary callers keep the existing `CaptureResult` API. Do not
  include `subagent_trajectories` as a second priced copy of merged child steps.
- [ ] **Qualify the actual corpus and child layout.** For each frozen fixture,
  normalize root/child and verify literal key facts through ATIF. For new analyst
  capture, replay retained native dispatch/child traces under the pinned CLI
  layout and cwd filters. If an owned child is filtered out, prefer supported
  child cwd/session-store configuration. Any necessary filtering change must use
  proven ancestry at the capture boundary and retain the unrelated-session
  exclusion test; never admit every new log indiscriminately.
- [ ] **Run GREEN and commit.** Run the named normalizer/capture tests plus
  `bun test test/obol.test.ts`. Compare pre/post-normalization semantics with
  only the newly added provenance removed. Investigate any changed token,
  timestamp, content, or call/result value separately. Commit as
  `Retain source evidence and per-session ATIF capture`.

### Task 3: Wire the full-report scenario and retain artifacts on failure

**Files:** Create `src/experiments/diagnosis/artifacts.ts`,
`test/diagnosis-artifacts.test.ts`, and
`scenarios/diagnosing-full-session/{story.md,setup.sh,checks.sh,checks-manifest.json}`.
Modify the finalization path in `src/runner/index.ts`; extend
`test/runner-unit.test.ts` and `test/runner-campaign-publication.test.ts`.

**Interfaces:** Define in `contracts.ts`, implement in `artifacts.ts`:

```ts
export interface RetainedArtifact {
  originalPath: string; retainedPath: string; sha256: string; bytes: number;
}
export interface DiagnosisArtifacts {
  schemaVersion: 1;
  files: RetainedArtifact[];
  preservation: FilePreservation[];
  errors: string[];
}
export interface CollectDiagnosisArgs extends FixtureArgs { runDir: string }
export function collectDiagnosisArtifacts(args: CollectDiagnosisArgs): DiagnosisArtifacts;
```

- [ ] **Write artifact retention tests.** Seed a case/report under the isolated
  `~/.superpowers/diagnosing-superpowers/<id>/` and another report in the workdir.
  Require exact bytes and original absolute paths in the retained inventory.
  Add cases for a partial case without report, modified historical bytes,
  disappearing files, and a symlink to an auth file. Preserve accessible partial
  evidence and report collection errors; never follow the symlink. A second
  collection cannot silently mix results from another attempt.
- [ ] **Implement the collector after RED.** Run
  `bun test test/diagnosis-artifacts.test.ts`. Collect reviewed historical files
  (including changed bytes with their mismatch recorded), associated neutral
  artifacts, and regular generated files under the diagnosis directory into
  `<runDir>/diagnosis-artifacts/`. Hash every retained file. Include the generated
  case and report even if only one exists. Workdir files already belong to run
  publication; inventory relevant report/evidence paths without recursively
  copying the workdir into itself. Collect per-file ATIF/source indexes from
  Task 2 through ordinary run publication. Write `diagnosis-artifacts.json` with
  both successes and errors; do not abort at the first changed history.
- [ ] **Retain historical ATIF separately from new usage.** Seeded histories
  precede the capture snapshot, so Task 2's index correctly contains only new
  diagnosis sessions. Normalize retained historical JSONL through the existing
  `ATIF_NORMALIZERS` boundary, using `unknown` for an unevidenced historical CLI
  version. Retain each trajectory under `diagnosis-history/atif-sources/` and a
  `SourceIndex` at `diagnosis-history/atif-sources.json`, with ids prefixed
  `history-`, original installed native paths, actual retained-byte digests, and
  run-relative trajectory paths. Its `mergedSteps` is empty: historical sources
  are not merged into or priced with new diagnosis work. Record normalization
  errors explicitly and keep the copied native bytes. Retain the fixture manifest
  for the private key's manifest-digest check. Test that this index exists on
  ordinary failure and that historical tokens never enter live usage.
- [ ] **Wire all normal finalization paths.** For scenario id
  `diagnosing-full-session`, call the collector in `runScenario` after the
  `runInner` try/catch and before final verdict/attempt manifest publication.
  Use `provenanceRunHome`, the existing workdir, and the trusted scenario manifest.
  Never reload an agent configuration or launch a CLI during collection.
  The normal post phase separately checks preservation; finalization retains
  evidence when capture errors or stops skip post checks. Record collection
  failures for offline incomplete assessment without masking the original
  verdict. Test success, early capture failure, and cooperative timeout using
  the existing fake Gauntlet/runner seams. A forced outer kill that prevents
  finalization remains incomplete; do not claim missing partial artifacts exist.
- [ ] **Write the exact scenario conversation.** Use the three frozen public
  requests from Task 1 verbatim in `story.md`, with `quorum_max_time: 15m`.
  Append this identical scope text to each:

  > Use diagnosing-superpowers to investigate this incident and write an
  > evidence-backed local report through the report step. Stop after delivering
  > the report and its absolute path. Do not search or file GitHub issues,
  > create a bundle, change code or skills, or search for similar incidents.

  The Gauntlet-Agent may provide only the frozen neutral intake answers. It
  stops after the first delivered report, explicit inability, or timeout, and
  never reveals target ids/paths, expected findings, or analyst reminders.
  ACs require skill exposure, report delivery or explicit limitation, and scope
  adherence. State that independent assessment determines substantive correctness.
- [ ] **Add setup and checks using the existing DSL.** Initialize the throwaway
  project with `create_cost_clean_repo`, then install the fixture manifest once.
  Commit the installed historical plan/artifact files so `assert-checkout-clean`
  measures the prepared fixture. The installer must not overwrite existing files.

  ```bash
  # checks.sh -- keep non-executable
  # coding-agents: claude,codex,pi
  pre() {
      git-repo
      git-branch main
      assert-checkout-clean
  }
  post() {
      check-transcript skill-called superpowers:diagnosing-superpowers
      command-succeeds "QUORUM_WORKDIR=\"$PWD\" QUORUM_AGENT_CONFIG_DIR=\"$QUORUM_AGENT_CONFIG_DIR\" bun \"$QUORUM_REPO_ROOT/src/cli/diagnosis-fixtures.ts\" verify \"$QUORUM_SCENARIO_DIR/history/$QUORUM_CODING_AGENT/manifest.json\" \"$QUORUM_SCENARIO_DIR/history/$QUORUM_CODING_AGENT\""
  }
  ```

  Use `setup.sh` to call `setup-helpers run create_cost_clean_repo` first and
  then the Task 1 installer once, avoiding a double installation. Native history
  must still precede the runner snapshot. Setup reads
  `$QUORUM_SCENARIO_DIR/history/$QUORUM_CODING_AGENT/manifest.json`; only the private
  runtime source contains those incident assets.
- [ ] **Verify and commit.** Run artifact/runner tests, generate the scenario's
  check manifest with `bun run quorum check --update-manifests`, and inspect that
  only the new manifest changes. Commit as
  `Add full-diagnosis scenario and retain partial report evidence`.

### Task 4: Implement private, independently reviewed report assessment

**Files:** Extend `contracts.ts`; create `src/experiments/diagnosis/assessment.ts`,
`src/cli/diagnosis-assessment.ts`, `test/diagnosis-assessment.test.ts`, and
`test/diagnosis-assessment-cli.test.ts`. Synthetic report/unit evidence may live
under `test/fixtures/diagnosis/`, explicitly labeled synthetic.
Extend `src/atif/provenance.ts`, `src/normalize/{claude,codex,pi}.ts`, and
`test/atif-provenance.test.ts` for the evidenced native parallel-batch boundary
and native result-record byte sizes.

**Interfaces:** Assessment accepts ordinary report prose. A reviewer transcribes
claims into a private sidecar; the Coding-Agent is not asked for a new output
schema. Bind extraction and semantic judgments to the exact retained report.

```ts
export type AssessmentStatus = 'pass' | 'fail' | 'incomplete';
export interface AssessedClaim {
  id: string; reportLines: [number, number]; text: string;
  citations: Array<{ path: string; line: number; quote: string }>;
  judgment: 'supported' | 'unsupported' | 'uncertain';
  reason: string;
}
export interface AnalystEvidence {
  dimension: Dimension;
  sourceId: string; // dispatcher source in the new-session index
  dispatchStepId: number; callId: string; batchIndex: number | null;
  childSourceId: string; // distinct linked execution, same new-session index
  completionStepId: number | null; // step in childSourceId
  casePath: string; commonPath: string; dimensionPath: string;
}
export interface QuantityObservation {
  id: string; claimId: string; value: number | null; scope: string;
  // value remains in the key's base unit. This describes the report's display.
  rounding: null | {
    unit: 'tokens' | 'kTokens' | 'MTokens' | 'ms' | 's' | 'min' |
      'bytes' | 'KiB' | 'MiB' | 'count';
    decimalPlaces: number; mode: 'nearest' | 'floor' | 'ceil';
  };
}
export interface ReviewItem {
  status: AssessmentStatus; reason: string; evidence: NativeLocator[];
}
export interface DiagnosisReview {
  schemaVersion: 1; reportSha256: string; keySha256: string;
  reportPath: string; // original absolute path delivered for the report
  targetSessionId: string; sourcePath: string; // historical native target
  historicalSessionIds: string[]; humanTurnIds: string[];
  recoveredFindingIds: string[];
  quantities: QuantityObservation[];
  claims: AssessedClaim[];
  nonClaimLines: Array<{ start: number; end: number; reason: string }>;
  analysts: AnalystEvidence[];
  dimensions: Record<Dimension, ReviewItem>;
  rubric: Record<
    'case' | 'environment' | 'timeline' | 'coverage' | 'involvement' |
    'contextSafety' | 'scope' | 'exposure' | 'reportDelivery' | 'negativeControls',
    ReviewItem
  >;
  reviewer: string; blinded: boolean; unblindingReason: string | null;
}
export interface DiagnosisAssessment {
  status: AssessmentStatus;
  checks: Array<{ name: string; status: AssessmentStatus; detail: string }>;
}
export interface AssessDiagnosisArgs {
  runDir: string; keyPath: string; reviewPath: string;
}
export function assessDiagnosis(args: AssessDiagnosisArgs): DiagnosisAssessment;
```

- [ ] **Retain native batched analyst relationships before assessing them.**
  The pinned Pi subagent extension uses `tasks[]` as parallel input and
  `details.mode: parallel` plus ordered `results[].sessionFile` as output.
  Add typed `NativeChildDispatch` with `index: number`, optional native `prompt`,
  and `child: NativeChildEvidence`; retain its array as `quorum_dispatches` on
  the canonical Agent call and result. The index identifies the actual ordered
  batch execution, not a made-up native call id. Keep the existing single-child
  `quorum_child` contract. Extract meanings at this normalizer boundary and keep
  native line provenance; do not bill the result's repeated child-usage summary.
  Use a literal synthetic native batch to establish RED, then verify separate
  child paths, prompts and indexes, single-child compatibility, and no duplicate
  usage. Unknown or malformed relationships stay unavailable. Qualify any task
  count expansion against the pinned extension's actual ordering before using
  it; do not invent a mapping. Task5's offline CLI qualification verifies this
  boundary against runtime-generated records before launch.
- [ ] **Preserve native record size as a distinct measurement.** Add optional
  `recordBytes` to `NativeEvidence` on source-mapped tool results: UTF-8 bytes
  of the literal serialized native JSONL record, excluding its line terminator.
  Preserve whitespace/escaping; do not compute it by reserializing decoded JSON.
  Keep existing `contentBytes` for decoded result content and keep all priced
  semantics unchanged. Add literal Unicode/escaping regressions on all three
  normalizers. The control cost prompt explicitly measures whole log lines,
  so a supported, labelled record-size report must not fail a hidden content-only
  convention. Private top-ten keys use ordinal measurement ids with separately
  evidenced sizing/ranking alternatives. Independent dimension review verifies
  a coherent ranking method and prevents mixing conventions to cherry-pick values.
  Prompt-to-next-human/end timings are also legitimate named alternatives to
  task-complete or final-assistant durations; freeze each with its own locators.
  Preserve Claude `system/turn_duration` as a completed turn boundary so the
  last-record timestamp remains available. Add optional `durationMs` to native
  boundaries for Claude `durationMs` and Codex `task_complete.duration_ms`;
  reported runtime counters and timestamp subtraction remain separate labelled
  measurements. Regress their literal retention without adding priced steps.
- [ ] **Build one correct synthetic assessment fixture.** Retain a report,
  historical sources, seven new analyst trajectories/dispatches, source index,
  artifact inventory, key, and review. Include an empty dimension with explicit
  checked coverage and a valid citation outside the key's preferred lines.
  Store literal timestamps/quantities; do not calculate expected values by
  calling the function under test. This fixture tests the checker, not model skill.
- [ ] **Write mutation tests before implementation.** Copy that fixture into a
  fresh temporary directory per case and test these independent mutations:

  | Mutation | Expected result |
  |---|---|
  | Correct report, extra supported citation, evidenced empty dimension | pass |
  | Wrong target or child omitted from report | fail |
  | Parent dispatch included as a human prompt | fail |
  | Duplicate cumulative usage or unsupported zero for missing usage | fail |
  | Claimed test success without evidence or legitimate reread called waste | fail |
  | Existing citation with an independently judged irrelevant quote | fail |
  | Seven headings, only six actual analyst executions | fail |
  | Analyst gets wrong case or dimension, or never completes | fail when trace proves it |
  | Historical files changed or delivered report path missing | fail |
  | Review drops a claim/citation or refers to different report bytes | incomplete |
  | Evaluator loses child evidence, source index, or required timestamp | incomplete |
  | Collection contains errors but preserves a partial report | incomplete, retain all checks |

  Tests assert named reasons as well as status. To test prose meaning, change
  the evidence-backed review judgment; do not claim a string matcher independently
  proved semantic entailment. Numeric/identity/dispatch mutations exercise real
  deterministic comparisons against ATIF and the key.
- [ ] **Run RED and implement the assessment.** Run
  `bun test test/diagnosis-assessment.test.ts`. Validate key/review structure and
  source/report digests first. Resolve the explicit reportPath through the retained
  original-path map, then bind its bytes to reportSha256. Identical report copies
  at other paths are valid; do not require a globally unique digest match. Verify
  original absolute paths through the retained path map. Validate complete report line coverage: each nonblank line must be
  covered exactly once by a claim span or a justified non-claim span. The reviewer
  must retain all findings and citations, including additional ones; headers and
  formatting may be non-claims, assertions may not. Audit this coverage in review.

  Compare recovered required findings, human-turn order, historical session set,
  and claimed quantities against the private literal key. Read metric/time/role
  evidence from `diagnosis-history/atif-sources.json` and its per-source ATIF;
  use Task 2's top-level source index for new controller/analyst executions.
  Scope tool-call ids by source and keep these two populations distinct.
  Extend `ExpectedQuantity` with optional `alternatives`, each containing its
  own `value`, `scope`, and `evidence`. Every millisecond entry and alternative
  also declares `measurement: 'elapsed-time' | 'native-duration'`; other units
  omit it. Elapsed measurements require both actual timestamp endpoints. Native
  duration measurements require the exact reported counter, independently of
  timestamps. Preserve boundary counters and typed result metadata
  `quorum_result: { isError?: boolean; durationMs?: number }` at normalization;
  failed tool results cannot prove input consumption. Singleton child-wrapper
  counters are separate from parent timestamps; do not collapse parallel counters.
  These are frozen native-backed values, not post-result allowances. If a schema
  refinement is needed before launch, derive metadata-only key copies and retain
  the original freeze and every value/scope/locator unchanged. Require the observation's scope to select an
  evidenced measurement. For displayed values, convert the declared compatible
  unit and decimal precision to a quantum and compare against the expected
  value rounded to that quantum; retain the exact expected and displayed values
  in the result. A reviewer must link the observation to the original claim and
  verify its scope and displayed precision. Use nearest rounding for ordinary
  displayed approximations; floor/ceil require evidence of that convention in
  the report or its retained calculation, not a reviewer-selected escape hatch.
  Do not use a broad numeric tolerance
  or permit an arbitrary quantum unrelated to the report. Extra quantities stay
  in claim coverage even when they are not required key measurements. Test both
  correct scoped/rounded alternatives and incorrect scope, missing usage shown
  as zero, and a rounded value outside the stated precision.
  Resolve every analyst dispatch and completion to actual ATIF records, check
  correct absolute inputs, native relationship evidence, and separate analyst ids.
  A batch execution uses the dispatcher source/call plus its zero-based batch
  position and distinct child source. Reusing a batch's native call id is valid;
  reusing a child as two analysts is not. Native batch relationships must be
  established at the normalization boundary, never reconstructed by a new raw
  assessment parser. Include a synthetic multi-child batch acceptance case.
  Where native dispatch text is encrypted, use the linked child's actual reads
  and results for the exact case/common/dimension files to establish input
  consumption; record prompt-text unavailability instead of guessing its contents.
  Case files are retained diagnosis artifacts. Installed common/dimension skill
  files can live outside the retained home/workdir inventory: their exact
  path-bound ATIF read results plus independent input/content judgments can
  establish consumption without a second collector copy. Require shared case
  and common inputs and the correct dimension; do not invent a path allowlist.
  A present report section does not prove an analyst ran. Check source preservation
  from Task 3 and exposure/scope/context behavior from retained controller/child
  tool calls plus independent review. Require every dimension and rubric entry.

  For each citation, resolve a retained regular source, verify the line exists,
  and verify the quoted text against either its literal line or its source-mapped
  normalized text. JSON escaping must not reject a decoded but faithful quote.
  Require the review's evidence-based support judgment independently of existence.
  Map `supported` to pass, `unsupported` to fail, and an unresolved reviewer
  judgment to incomplete. A report's honest uncertainty can itself be a supported
  claim; it does not require the reviewer to mark their own judgment uncertain.
  Do not require membership in `requiredFindings[].evidence`; reject missing or
  irrelevant evidence, not alternative valid evidence.

  Combine statuses without losing individual failures:

  ```ts
  const status: AssessmentStatus = checks.some((c) => c.status === 'incomplete')
    ? 'incomplete'
    : checks.some((c) => c.status === 'fail') ? 'fail' : 'pass';
  return { status, checks };
  ```

  An incomplete assessment can still contain established behavioral failures.
  Never rewrite `verdict.json` or a campaign report from this offline result.
- [ ] **Add the private CLI and its tests.** Command:
  `bun src/cli/diagnosis-assessment.ts <retained-run-dir> <key.json> <review.json> <output-dir>`.
  Refuse output inside retained input trees or an existing assessment directory.
  Preserve the exact report, key/review digests, all judgments/citations, and
  machine-readable `assessment.json` plus a short Markdown summary. Return 0 for
  pass, 1 for fail, 127 for incomplete or invalid evaluator input. CLI tests cover
  those exits and ensure no run/key inputs are changed. The CLI is never called
  from the worker's checks or Gauntlet context.
- [ ] **Run GREEN and commit.** Run the assessment and CLI tests, plus the old
  discovery evidence tests to ensure their frozen semantics are unchanged.
  Commit as `Add independent full-diagnosis report assessment`.

### Task 5: Freeze the six-run configuration and prepare the launch packet

**Files:** Create `arms/pr2236_full_{claude,codex,pi}_{before,after}.yaml`,
`suites/pr2236_full_diagnosis.yaml`, `test/pr2236-full-diagnosis-config.test.ts`,
and `docs/experiments/2026-09-09-pr2236-full-diagnosis.md`. Private deliverables:
qualified fixture source commit, Linux qualification logs, runtime/model inventory,
cost estimate, and `launch-packet.json`/`launch-packet.md`.

**Interfaces:** Reuse `ArmSchema`, `SuiteSchema`, `GraderSchema`, and the existing
appliance registration/preparation APIs. The packet references immutable actual
commits/digests; it is an operator artifact, not a new campaign schema.

- [ ] **Write config tests and run RED.** Use the existing
  `test/pr2236-pilot-config.test.ts` schema-loading pattern. Assert three paired
  comparisons expand to exactly six attempts, latest treatment on all three,
  prescribed credentials/effort, Linux, one scenario, no reserve, and 1,200-second
  attempt bounds. Validate a 15-minute story and absence of this pilot's private
  keys/native incident assets from the public implementation tree. Existing
  repository fixtures and new explicitly synthetic unit data remain valid.
- [ ] **Write the six arms and suite.** Each arm has `schema_version: 1`, its
  filename's name, corresponding `agent`, `os: linux`, specified `credential`,
  and the control/treatment runtime SHA. Add `effort: high` only for Claude/Codex.
  The complete suite is:

  ```yaml
  schema_version: 2
  name: pr2236_full_diagnosis
  reserve: 0
  max_exposure_skew: 60
  attempt_bounds:
    max_attempts: 1
    max_time_s: 1200
  grader:
    credential: sonnet5
    model: claude-sonnet-5
  comparisons:
    - baseline: pr2236_full_claude_before
      treatment: pr2236_full_claude_after
      scenarios: [diagnosing-full-session]
      n: 1
    - baseline: pr2236_full_codex_before
      treatment: pr2236_full_codex_after
      scenarios: [diagnosing-full-session]
      n: 1
    - baseline: pr2236_full_pi_before
      treatment: pr2236_full_pi_after
      scenarios: [diagnosing-full-session]
      n: 1
  ```

- [ ] **Qualify the actual scenario setup script.** The frozen native corpus
  installs only session-store files, while `create_cost_clean_repo` already
  commits its README. The unconditional final commit therefore exits with
  "nothing to commit" before any diagnosis. Commit workdir fixture changes only
  when present, preserving clean setup for session-store-only inputs. Add a
  provider-free regression that executes the real `setup.sh`, helper, and fixture
  CLI against synthetic manifests; cover session-store-only and workdir fixtures.
  The controller also runs the script against all three frozen corpora and the
  pinned Linux runtime before launch.
- [ ] **Run final code/scenario checks.** Run the config tests,
  `bun run check`, and `bun run quorum check`. Resolve failures in scope; record
  actual test counts and platform skips. Do not run live `quorum run` in CI or
  treat unit test success as proof of native analyst behavior.
- [ ] **Commit the public runtime inputs.** Start the experiment entry with the
  question, fixed limits, qualification requirements, and deferred cases. Commit
  the scenario, six arms, suite, config tests, and entry as
  `Add six-run full-diagnosis declarations`. This is the implementation commit
  from which the next step derives the private runtime, so the runtime already
  contains the exact declarations being qualified.
- [ ] **Create the private runtime source.** After committing the public
  implementation, use a separate private worktree at that exact commit. Copy
  only the reviewed neutral fixture manifests/files beneath
  `scenarios/diagnosing-full-session/history/{claude,codex,pi}/`, validate hashes,
  and make a private fixture commit. Do not copy keys, assessments, original
  corpus inventories, target labels, or this task's operator notes into that
  directory. Record implementation/runtime commit relationship and full runtime
  file inventory. Sync the exact private source to the existing isolated appliance
  namespace using private Git bundles, preserving the configured shared lock and
  credential bundle. Keep canonical appliance checkouts unchanged.
- [ ] **Qualify the pinned Linux image offline.** Follow
  `docs/appliance-runbook.md` and `docs/campaign-comparisons.md`. Inspect CLI and
  extension versions, both installed Superpowers package manifests, model/effort
  configuration, session directories, and analyst tool support. Use retained
  native traces and the repo's fake-provider seams with network/credentials
  disabled for invocation tests. Verify capture includes child work and the
  diagnosis directory enters immutable publication on ordinary failure paths.
  Confirm the scenario's configured analyst model policy matches in both arms.
  Verify native concurrency supports parallel waves; record the actual cap and
  account for two simultaneous top-level attempts. Do not invent unsupported
  config flags or claim offline fake-provider tests are behavioral results.
- [ ] **Qualify pricing and finite admission.** Price retained representative
  controller/analyst ATIF through obol; inspect missing prices and suspicious
  embedded zero costs against the pinned provider configuration. Any required
  normalization/provider correction needs its own focused regression before
  admission; do not add a raw-log pricing bypass. Produce an estimate for six
  controllers, 42 expected analysts, six Gauntlet-Agent drives, and plausible
  overrun within the frozen time/count limits. State the assumptions and coverage.
  Use offline registration preparation to prove six eligible slots, global cap
  two, zero exclusions/reserve, and the exact subject/grader routes.

  Offline qualification has established a concrete correction: Pi's custom
  `quorum` provider is provisioned without model price rates, and the pinned Pi
  registry turns those absent rates into zero-valued native costs. Preserve that
  recorded zero as evidence, but do not expose it as an authoritative ATIF
  `metrics.cost_usd` for such a model. Thread an optional normalization context
  from the runner's already-resolved provisioning route through capture to Pi;
  scope the policy to the evidenced custom provider/model with unspecified rates.
  Do not infer that every Pi zero is a placeholder, read raw logs in pricing, or
  reload credentials after capture. Other providers, positive recorded costs,
  and authoritative zeros without that policy keep existing behavior. Retain
  the policy/recorded value in ATIF metadata so obol can price the canonical token
  buckets and expose missing rates normally. Tests must prove the scoped zero
  becomes rate-priced, genuine zero remains zero, root/child usage is counted
  once, and the runner actually threads the policy. Unknown historical contexts
  remain explicitly unqualified; do not rewrite frozen historical artifacts.
  Include these code/tests in the public implementation before deriving the
  private runtime, or rebuild the runtime if already derived.
- [ ] **Finish the launch packet and preregistration.** Include actual source,
  image, Gauntlet, fixture/key, request, model/effort, child concurrency, and
  pricing identities; run limits; cost estimate; proposed new allowance; exact
  helper/config/results namespace; and evidence-review procedure. The experiment
  entry records hypotheses, required findings by non-sensitive labels, limits,
  and deferred cases without exposing private answers. Commit the documentation
  update as `Record full-diagnosis launch readiness`; this metadata-only commit
  does not replace the qualified private runtime source. If qualification required
  a code/config change, first commit it, rebuild the private runtime from that
  source, and requalify the affected path. Present the concrete packet for the
  new live-spend authorization. Do not register/launch a substitute pilot if a
  fixture, child capture, or pricing qualification remains unresolved.

### Task 6: Execute once and report all outcomes

**Files:** Update `docs/experiments/2026-09-09-pr2236-full-diagnosis.md`. Retain
private registration, identity, launch receipt, status/cost snapshots, authenticated
run artifacts, per-attempt review sidecars, and assessments.

**Interfaces:** Installed `evals-appliance campaign register|run|status|costs|report|cancel`
and the Task 4 offline CLI. This task is conditional on explicit authorization
of Task 5's concrete live-spend packet; the previous discovery allowance is not
that authorization.

- [ ] **Register and consume one launch.** Verify the approved packet's source
  identities again; register its exact suite with global cap two, retain the
  returned campaign id/input digest, then invoke `run` once for that identity.
  Never substitute an old campaign id or replay a launch receipt.
- [ ] **Monitor finite execution.** Use helper status and all-attempt costs.
  Preserve failures and timeouts; no reserve, rescue prompt, extra smoke, model
  downgrade, or automatic rerun. Follow exact-identity cancellation if required
  by the authorized allowance or a runtime failure. Do not inspect active
  behavioral outputs around the campaign's report gate.
- [ ] **Collect after termination.** Use the helper's terminal report and
  authenticated artifact references; verify hashes and termination status.
  Preserve every attempt and formal validity status. Missing analyst evidence,
  forced-kill artifact loss, or incomplete publication remains explicit.
- [ ] **Review each result independently.** Prepare neutral arm labels where
  feasible. Read the original report, case, historical native evidence, per-source
  ATIF, all seven analyst exchanges, and tool-read behavior. Fill every claim,
  citation, dimension, rubric, numeric value, and coverage field in the private
  review. Validate against the pre-frozen key. Record unblinding and disagreements
  with Gauntlet/Quorum. Run the Task 4 CLI in a fresh private output directory per
  attempt. Never change the key to accommodate a subject output.
- [ ] **Publish the readout and commit.** One row per harness/arm with report
  acceptance, seven-analyst coverage, required/unsupported findings, citation and
  numeric accuracy, source/context compliance, report delivery, diagnosis and
  attempt duration, and complete/missing usage coverage. Sum all new controller
  and analyst costs once through ATIF/obol; keep Gauntlet costs separate and
  historical incident costs out of the experiment spend. Preserve formal campaign
  completion separately from independent judgments. Record failures at equal
  billing, observed differences, and the n=1 limit. Commit as
  `Record full-diagnosis comparison outcomes`; propose only evidence-motivated
  follow-ups, without launching them.

## Plan self-review

- Corpus, true human prompts, historical child, negative controls, provenance,
  and no hidden fixture-generation calls: Task 1.
- Canonical ATIF, source locators, native roles, usage/timing, and new child capture:
  Task 2; literal fixture qualification prevents a circular oracle.
- Intake, complete skill flow, absolute report path, source preservation,
  home artifact publication, and failed-run evidence: Task 3.
- Seven actual analysts, all report sections, supported/unsupported claims,
  alternative citations, negative results, and incomplete-evidence attribution:
  Task 4, with the independent review explicitly retained.
- Same before/after bytes and settings, runtime isolation, six finite attempts,
  child-inclusive estimate, and concrete new allowance: Task 5.
- One launch, immutable evidence, all-attempt costs, separate actor populations,
  complete/incomplete reporting, and restrained inference: Task 6.
- Optional GitHub/export/similar-session branches remain deferred. The plan
  uses the existing assessment and campaign architecture.
