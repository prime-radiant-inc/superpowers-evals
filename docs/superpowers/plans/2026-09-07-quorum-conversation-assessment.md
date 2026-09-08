# Quorum conversation and assessment implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Implementation status:** All seven tasks completed offline; final corrections accepted.
[Paired revisions, review outcomes, actual test receipts and proposed appliance pilot](../../experiments/2026-09-07-conversation-assessment-implementation.md).
The checklist below preserves the original execution instructions.

**Goal:** Run `conversation-pricing` through a real Claude or Codex terminal, with a simulated user, independent checks and a separate assessment, inside the current Quorum worker.

**Architecture:** Reuse Quorum provisioning and generated launchers. Select the new flow immediately before the existing Gauntlet invocation; a focused runner function performs conversation, evidence capture, checks and assessment. Gauntlet supplies two small role-specific entrypoints using its existing providers, terminal and evidence logger.

**Tech Stack:** TypeScript, Bun, existing Node filesystem/subprocess APIs, tmux, existing Zod contracts and Obol accounting. Preserve the repositories' existing dependencies and Bun floors: Quorum's installed toolchain and Gauntlet's `>=1.3.14`.

**Spec:** [Approved conversation/assessment design](../specs/2026-09-07-quorum-conversation-assessment-design.md).

## Global constraints

These requirements apply to every task; quoted sentences are from the spec.

- “One complete scenario on Linux Claude and Codex, using current Quorum workers and appliance execution.”
- “Both Gauntlet roles initially use the same configured controller model and credential, with separate histories and tool access.”
- “This increment does not change campaign admission, publication, validity, replacement or sealing policy.”
- “It adds no scheduler, grading queue, service, credential registry, generic eval interface, regrading system or dashboard.”
- “Only the new scenario opts in initially”; absent `quorum_mode` retains the existing QA flow. Reject unknown values and unsupported conversation harnesses before launch.
- “No later error may overwrite an already observed completion.”
- Conversation is bounded by `quorum_max_time: 10m`; assessment is bounded by two minutes. Parent enforcement includes child startup and awaited model calls. Preserve the outer attempt deadline.
- “This spec authorizes no live calls by itself.” Complete offline implementation and verification before writing the finite appliance run plan.
- Follow each repository's instructions and formatting. Do not add compatibility readers, change campaign policy, or reorganize the existing runner beyond the integration seam below.

## Source baseline and execution order

Inspected Quorum at `1d28da5a` (runtime unchanged from `32b403be`) and Gauntlet at `588a81e80fe3cd7b7d3bc2c7f4207bed4ecb14df`. Recheck the diffs against these baselines when execution begins. Keep this planning branch's documents; create isolated implementation branches/worktrees in both repositories using the worktree skill. Gauntlet's main checkout contains untracked `.agents/` and `ui/dist-static/`; they are outside this implementation and need not be moved or staged.

In this document **Q** means `/Users/drewritter/prime-rad/superpowers-evals`; **G** means `/Users/drewritter/prime-rad/gauntlet`. Paths in task file lists are relative to the explicitly named repository. Resolve them inside its implementation worktree when executing. No package link, installation, deployment or live run is needed to write or test these changes.

Implement Tasks 1–3 in Gauntlet, then Tasks 4–7 in Quorum. Task 4 can run independently alongside Gauntlet work. Review each task's meaningful behavior and commit it before proceeding. The first deliverable is the prepared terminal in Task 1; the first complete simulated-user interaction is Task 2. Do not begin with framework extraction.

## File and boundary map

| Repository / files | Responsibility |
|---|---|
| G `src/adapters/tui/adapter.ts` | Prepared launcher startup, private socket, exit detection and input closure |
| G new `src/conversation/{record,converse}.ts`, `src/context/scoped-read.ts` | Completion record, shared contained file reader and the user-only loop |
| G new `src/assessment/assess.ts` | Selected evidence reading and fresh assessment loop |
| G `src/cli/args.ts`, `src/index.ts`; new `src/cli/{converse,assess}.ts` | Two explicit CLI commands and role setup/logging |
| Q `src/capture/index.ts`, exercised normalizers, `src/check/transcript.ts`, `src/check/transcript-dispatch.ts`, `src/checks/index.ts` | Usable transcript versus absent/broken capture, through the existing checks |
| Q `src/check/fs-verbs.ts` | Correct child exit classification |
| Q `src/story-meta.ts`, `src/scaffold.ts`; new `src/runner/conversation-input.ts` | Mode validation and private story projection |
| Q new `src/contracts/conversation.ts`, additions to `src/contracts/verdict.ts` | Small completion and role records; retained criterion results |
| Q new `src/capture/output.ts`; new `scenarios/conversation-pricing/` | Retained small output, native evidence and trusted pricing oracle |
| Q new `src/runner/{gauntlet-role,conversation}.ts`; `src/runner/index.ts`, `src/runner/stopped.ts`, `src/cli/run-command.ts` | Parent deadlines, exact cleanup, sequential flow and completion-preserving finalization |
| Q `src/composer.ts`, `src/economics.ts`, `src/cli/render.ts` | Existing verdict semantics, both role costs and per-run readout |
| Both repositories' task-specific tests; Q scenario authoring/runbook docs | Offline behavioral proof and accurate usage documentation |

The new files hold this capability's code. They do not require moving the ordinary QA loop, building a generic role registry or changing the scheduler.

## Wire contracts used by the tasks

These are new interfaces to implement. Keep their JSON representation identical across the subprocess boundary; do not introduce a shared package for two small records.

```ts
type ConversationRecord = {
  status: 'completed' | 'stopped' | 'timed_out' | 'errored';
  endpoint: 'delivery' | 'refusal' | null;
  reason: string;
  timestamp: string; // ISO timestamp
  evidence: { path: string; quote: string } | null;
};
type EvidenceIndex = { files: string[] };
type GauntletRoleRecord = {
  out_dir: string; // run-root-relative, allocated by Quorum
  model: string;
  started_at: string | null;
  finished_at: string | null;
  process_exit: { code: number | null; signal: string | null } | null;
  stop_cause: 'cancelled' | 'timed_out' | null;
};
type GauntletRoles = {
  conversation: GauntletRoleRecord;
  assessment: GauntletRoleRecord;
};
```

`ConversationRecord.evidence.path` is relative to the Quorum run root, points to a saved visible capture, and accompanies a nonempty quote from that capture. `completed` requires a non-null endpoint and evidence; the other statuses have a null endpoint and may cite the last screen. An observed completion remains authoritative if cleanup subsequently fails.

`EvidenceIndex.files` contains normalized relative paths under the supplied evidence root. It is an exact readable-file list, not a glob. Reject absolute paths, traversal, duplicate paths, special files and realpath/symlink escapes. The index never grants access to the rest of the run directory.

Quorum writes `gauntlet-roles.json` with both roles allocated but not started, and updates each role on actual child spawn/settlement. The launch timestamp also starts its parent deadline. It is accounting/process evidence, not a campaign transition or recovery journal.

Quorum chooses role output directory names with Gauntlet's existing run-id shape, `<scenario>_<YYYYMMDDTHHMMSSZ>_<four base36 characters>`. Gauntlet validates the basename with `parseRunId` in G `src/util/id.ts`; the assessor also verifies the rubric's scenario id. Select these exact directories, never whichever result directory sorts first or last.

```text
<run>/conversation.json
<run>/gauntlet-roles.json
<run>/conversation-agent/<conversation-run-id>/{run.jsonl,usage.jsonl,exchange.jsonl,captures/}
<run>/gauntlet-agent/results/<assessment-run-id>/{result.json,result.md,run.jsonl,usage.jsonl}
<run>/conversation-input/{user-brief.md,rubric.md}
<run>/evidence/{index.json,checks.json,conversation.json,trajectory.json,native/,output/,visible/}
```

Private role logs and the user brief are retained in the run but are not automatically included in the assessor's index. Copy the user-visible captures/exchange into `evidence/visible`, preserving their relative capture names. In the assessor's `evidence/conversation.json` projection, map the completion reference to that retained visible path; keep the run-root record unchanged. Include selected native logs and the normalized trajectory, the output and checks. Do not copy the credential HOME. No general artifact-format version or historical reconstruction is introduced.

### Task 1: Launch and contain the prepared terminal

**Repository:** G.

**Files:** Modify `src/adapters/tui/adapter.ts`; create `test/adapters/tui/prepared-subject.test.ts`. Reuse `src/runtime/process-tree.ts`, `src/runtime/spawn.ts` and the existing TUI tests.

**Interface:** Add `preparedSubject?: { launcherPath: string; workspace: string; socketPath: string }` to `TUIAdapterOptions`, plus `hasSubjectExited(): Promise<boolean>` and `finishInput(): void` on `TUIAdapter`. Existing `start(target)`, `readScreen`, `type`, `press`, `typeAndSubmit` and `close` stay available.

- [ ] **Write failing real-terminal tests.** Create a temporary executable fixture that prints a question, reads one answer, prints a delivery, and exits. It also appends one line to a launch-count file. Use a real tmux server and short bounded polling for observations; do not compare generated command strings. The assertion core is:

  ```ts
  await adapter.start('');
  expect(await adapter.hasSubjectExited()).toBe(false);
  await adapter.typeAndSubmit('Charge full price.');
  // Poll hasSubjectExited for at most two seconds before these assertions.
  expect(await adapter.hasSubjectExited()).toBe(true);
  expect(await adapter.readScreen()).toContain('Delivered: Charge full price.');
  await expect(adapter.type('touch should-not-exist')).rejects.toThrow();
  ```

  Construct the adapter with the three prepared paths and a temporary `runDir`. Verify the launch-count file contains exactly one entry, a second start rejects, no post-exit input creates a file, and a launcher path containing spaces works. An immediate refusal-and-exit fixture must retain its final screen. A separate test calls `finishInput()` while the fixture is still waiting and verifies all input methods reject. Always close the adapter and remove temporary files in `finally`.

- [ ] **Run the new test to establish the failure:** `bun test test/adapters/tui/prepared-subject.test.ts`. Expect missing prepared-start behavior or missing methods. Require tmux for this test run; a skipped terminal suite is not a passing receipt.

- [ ] **Implement prepared startup and input closure.** In prepared mode, validate an absolute executable launcher and workspace before spawning. Use the supplied private socket with `tmux -S`, and a private tmux config that sets `remain-on-exit on` before session creation. Pass multiple command arguments to `new-session`: `/usr/bin/env`, `--`, the exact launcher path; set `-c` to the prepared workspace. This directly executes the launcher without leaving an interactive shell. The ordinary QA startup remains the existing bash path.

  ```ts
  async hasSubjectExited(): Promise<boolean> {
    // Query this adapter's exact pane, not a process-name search.
    const result = spawnSync(this.tmux(
      'display-message', '-p', '-t', this.sessionName, '#{pane_dead}',
    ));
    if (result.exitCode !== 0) return true;
    return new TextDecoder().decode(result.stdout).trim() === '1';
  }
  ```

  Gate `type`, `press` and `typeAndSubmit` on both the completion flag and pane liveness; apply the same gate in tool dispatch. Reject reuse of a started/closed prepared adapter. Preserve the existing descendant discovery, grace period and reaping in `close()`, including when a retained pane is already dead. Do not require shared bash/context/credential tools for prepared mode.

- [ ] **Run the new and existing TUI tests:** `bun test test/adapters/tui`. Expect the prepared exchange and ordinary QA terminal behavior to pass, with no surviving private server or fixture process.
- [ ] **Commit the prepared-terminal change and its tests.** Stage only the two task files. Commit intent: execute the exact prepared harness and close input at the subject boundary; document the real tmux receipt.

### Task 2: Add the simulated-user command

**Repository:** G.

**Files:** Create `src/conversation/record.ts`, `src/context/scoped-read.ts`, `src/conversation/converse.ts`, `src/cli/converse.ts`; modify `src/cli/args.ts` and `src/index.ts`; create `test/conversation/converse.test.ts`, `test/context/scoped-read.test.ts`; extend `test/cli/args.test.ts`.

**Interfaces:** Implement `readWorkspaceFile(root: string, path: string): string`, `validateConversationRecord(value: unknown): ConversationRecord`, and:

```ts
type ConverseOptions = {
  brief: string;
  adapter: TUIAdapter;
  workspace: string;
  outDir: string;
  completionPath: string;
  client: LLMClient;
  logger: EvidenceLogger;
  runId: RunId;
  maxTimeMs: number;
};
function runConversation(options: ConverseOptions): Promise<ConversationRecord>;
```

`TUIAdapter`, `LLMClient`, `EvidenceLogger`, and branded `RunId` are the existing G types. The CLI initializes the provider and logger with the selected model, constructs the prepared adapter, and invokes the role. `runConversation` owns the single `adapter.start('')` and its `finally` cleanup. It accepts:

```text
gauntlet converse <user-brief.md> --launcher <absolute executable>
  --workspace <absolute path> --out <conversation role directory>
  --completion <run-root/conversation.json> --tmux-socket <absolute socket>
  --model agent=<selected model> --max-time 10m
```

- [ ] **Write failing role/dispatch tests using a scripted `LLMClient`.** Implement the fake with the existing `chat`, `userMessage` and `toolResultMessages` interface; queue explicit tool calls and retain each supplied prompt/tool list/history for assertions. Its replies drive `read_screen`, answer the fixture's question, then call `finish_conversation`. Verify the saved endpoint quotes an actual returned screen and remains present when `adapter.close()` throws. Also test a nonexistent capture, fabricated quote, unadvertised `bash`/credential/log tool, file traversal, symlink escape and input after finish. Use actual temporary files for file-tool checks:

  ```ts
  const root = mkdtempSync(join(tmpdir(), 'conversation-read-'));
  try {
    writeFileSync(join(root, 'answer.md'), 'Here is the implementation.');
    expect(readWorkspaceFile(root, 'answer.md')).toBe('Here is the implementation.');
    expect(() => readWorkspaceFile(root, '../private-rubric.md')).toThrow();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
  ```

  Include a spy ensuring neither the QA `runAgent` nor `buildSharedTools` is called by the role. Test CLI required flags, unsupported flags and invalid run-id output directories through parsed structures.

- [ ] **Run:** `bun test test/conversation test/context/scoped-read.test.ts test/cli/args.test.ts`. Expect new-command/import failures before implementation.
- [ ] **Implement the user-only loop.** Its system instructions are: play the described user, answer naturally, do not judge or coach, read workspace files when the subject presents them, and finish on visible delivery/refusal even if bad. Initialize a fresh history with only the projected brief. Use `LLMClient.chat`, `pushAssistantTurn`, `toolResultMessages` and `EvidenceLogger` directly; reuse provider resolution and raw-usage logging from the existing agent without invoking its QA loop, reflections or final grading pass. Call `logger.logRunStart` before model work: `logUsageRow` obtains provider/model attribution from it. Preserve missing raw usage as missing.

  Advertise and dispatch only `read_screen`, `type`, `press`, `type_and_submit`, `wait_for_activity`, `read_workspace_file` and `finish_conversation`. A terminal activity wait returns `changed | exited | timeout` on a changed screen or subject exit, within its requested bounded interval; it must not await an entire Coding-Agent turn. Screen polling is sufficient for this slice and avoids exposing log-inspection tools. In prepared mode, return the capture reference alongside screen text to the model: the existing internal `capturePath` alone is not model-visible. Keep a set of captures actually returned to the actor. Finish requires `{endpoint, reason, capture, quote}`; validate endpoint, nonempty reason/quote, returned capture identity and quote containment in the rendered visible text, using the existing parsed capture cells rather than raw ANSI escapes.

  ```ts
  // After validating the finish arguments and their observed capture:
  adapter.finishInput();
  const record: ConversationRecord = {
    status: 'completed', endpoint, reason,
    timestamp: new Date().toISOString(),
    evidence: { path: relative(dirname(completionPath), capturePath), quote },
  };
  writeFileSync(`${completionPath}.tmp`, JSON.stringify(record) + '\n');
  renameSync(`${completionPath}.tmp`, completionPath);
  ```

  Persist before cleanup. Execute model tool calls in order; once finish is accepted, execute no remaining calls in that response. The file reader uses realpath containment and regular-file checks, grants read access only inside the scenario workspace, and supplies no general execution. Validate tool arguments again at dispatch; an unadvertised call returns an error without reaching shared tools. Log model responses/tool results/raw usage per call. Also append `exchange.jsonl` entries for successful terminal inputs and returned screens: `{timestamp, kind: 'input', tool, args}` or `{timestamp, kind: 'screen', path}`. These record the user-visible exchange without copying private controller prompts/reasoning. On an ordinary role error before an endpoint, write `errored`; on a handled stop, write `stopped`. Preserve a valid completed record in both cases. Parent enforcement in Task 6 handles a role hung inside an awaited request.

- [ ] **Run the conversation, CLI and TUI tests plus `bun run typecheck`.** Expect the actual question/answer exchange to finish without any grading call. Verify forbidden tool calls never execute, including after a valid finish in the same response.
- [ ] **Commit the conversation command with its tests.** Explain private input separation, role permissions and completion-before-cleanup ordering.

### Task 3: Add the independent assessment command

**Repository:** G.

**Files:** Create `src/assessment/assess.ts`, `src/cli/assess.ts`; modify `src/context/scoped-read.ts`, `src/cli/args.ts`, `src/index.ts`; create `test/assessment/assess.test.ts`; extend `test/context/scoped-read.test.ts`, `test/cli/args.test.ts`. Reuse `src/agent/validators.ts`, `src/evidence/writer.ts` and `src/format/story-card.ts`.

**Interfaces:** Add `readEvidenceFile(root: string, index: EvidenceIndex, path: string): string` to the Task 2 reader, checking index membership before reusing its contained regular-file read. Implement:

```ts
type AssessOptions = {
  rubric: StoryCard;
  evidenceRoot: string;
  evidenceIndex: EvidenceIndex;
  outDir: string;
  client: LLMClient;
  logger: EvidenceLogger;
  runId: RunId;
  maxTimeMs: number;
};
function runAssessment(options: AssessOptions): Promise<VetResult>;
```

`StoryCard`, `VetResult`, client/logger/id types are existing G types. The command accepts:

```text
gauntlet assess <rubric.md> --evidence-root <retained evidence directory>
  --evidence-index <index.json> --out <exact assessment result directory>
  --model agent=<selected model> --max-time 2m
```

- [ ] **Write failing assessment tests with a scripted client and temporary evidence.** Verify the initial history contains the private rubric and evidence index, never the conversation actor's model history. Exercise valid pass/fail/investigate, missing criterion, empty evidence, overall pass with a failed/unclear criterion, and reading unlisted files. Direct calls to terminal, shell and subject-control tools must fail. Reuse the existing criterion validators in tests:

  ```ts
  expect(parseReportCriteria(undefined, ['Followed the user policy']).ok).toBe(false);
  const parsed = parseReportCriteria([
    { criterion: 'Policy handling', verdict: 'fail', evidence: 'visible/001.txt: refused' },
  ], ['Followed the user policy']);
  expect(parsed.ok).toBe(true);
  // Feed this table with overall pass through runAssessment: it must be rejected.
  ```

  Criterion descriptions are positional restatements, not exact-string copies. Include index traversal/symlink cases and a test that no adapter is constructed.
- [ ] **Run:** `bun test test/assessment test/context/scoped-read.test.ts test/cli/args.test.ts`. Expect missing assessment implementation failures.
- [ ] **Implement the fresh evidence-only loop.** Advertise/dispatch only `read_evidence` and the existing `REPORT_TOOL`'s `report_result`; no QA adapter or shared tools. List exact available paths in the initial message. Keep artifact contents marked as evidence, not instructions, and instruct the assessor to cite the supplied files. Use `parseReportResult`, `parseReportCriteria` and `checkCriteriaConsistency` for status, summary, reasoning, observations, required criterion coverage and nonempty evidence. Return a validation error to the model for an invalid report; never salvage an invalid overall pass as valid. Keep the existing free-text criterion evidence shape; do not add a citation language.

  ```ts
  // The dispatcher uses an explicit closed set, even if a model invents a tool.
  if (call.name !== 'read_evidence' && call.name !== 'report_result') {
    return textResult(`Error: unavailable assessment tool: ${call.name}`);
  }
  ```

  Write the existing `VetResult` through `writeResultFiles`, retaining its criterion array. Omit optional `config`: its existing adapter field cannot truthfully describe this role. Model/launch attribution comes from the role's logger and Quorum's role record. Do not introduce a fictitious TUI adapter or change the old result schema. Call `logRunStart` before logging every model call's raw usage, including validation retries. A timeout fallback may be `investigate`, never an unvalidated pass; the parent supplies the hard bound.
- [ ] **Run assessment/CLI tests, existing report-validator tests and `bun run typecheck`.** Verify conversation results never land in `gauntlet-agent/results` and only the actual assessor creates a grading result.
- [ ] **Commit the assessor and tests.** Record the retained result schema and fresh-history/tool boundary.

### Task 4: Preserve message-only capture and correct checker deaths

**Repository:** Q. This task is independently executable alongside Tasks 1–3.

**Files:** Modify `src/capture/index.ts`, `src/normalize/claude.ts`, `src/normalize/codex.ts`, `src/check/transcript.ts`, `src/check/transcript-dispatch.ts`, `src/check/dispatch.ts`, `src/cli/check-transcript.ts`, `src/checks/index.ts`, `src/check/fs-verbs.ts`, `src/runner/index.ts`, `src/composer.ts`. Extend `test/capture.test.ts`, `test/normalize.claude.test.ts`, `test/normalize.codex.test.ts`, `test/check-transcript.test.ts`, `test/check-tool.test.ts`, `test/checks.test.ts`, `test/runner-cascade.test.ts` and `test/composer.test.ts`.

**Interfaces:** Extend existing `CaptureResult` with `availability: 'available' | 'unavailable' | 'errored'` and `errors: readonly {sourceLog: string; stage: 'read' | 'normalize'; message: string}[]`. Keep `rowCount` as the tool count. Add optional third argument `onMalformedLine?: (line: number, message: string) => void` to `normalizeClaudeLegacy`, `normalizeCodex` and the capture module's `AtifNormalizer` function type; other normalizers need no implementation change. Extend `RunPhaseArgs` with optional `captureAvailability` of that same union; project it as `QUORUM_CAPTURE_AVAILABILITY`. `loadCalls()` returns `{calls, availability}`; dispatch rejects unavailable/errored evidence as a broken check before any positive or negated predicate runs.

- [ ] **Write failing behavior tests.** Native Claude and Codex message-only refusals must produce a retained trajectory, zero tool rows, `available` and one capture attempt. Add a valid source plus a malformed selected source, delayed valid data on retry, and Codex's synthetic empty/usage-only fallback. For checks, valid zero-tool evidence makes a positive tool requirement fail normally and a negative one pass; absent/corrupt capture must not establish either assertion. Test actual signalled children using the existing `ctxFor` fixture:

  ```ts
  const result = verbCommandSucceeds(['kill -TERM $$'], ctxFor(workdir()));
  expect(result.passed).toBe(false);
  expect(result.broken).toBe(true);
  ```

  Also exercise `exec` of a nonexistent interpreter and normal exits 0/1. A killed oracle through `runPhase` must retain its broken check record and produce a nonzero phase result, including under `not`.
- [ ] **Run:** `bun test test/capture.test.ts test/check-transcript.test.ts test/check-tool.test.ts test/checks.test.ts test/runner-cascade.test.ts`. Expect the zero-tool deletion and signalled-child false pass to fail their assertions.
- [ ] **Implement availability through the exercised path.** Preserve a trajectory containing meaningful message text or tool evidence. Do not use `steps.length` alone: Codex emits an empty synthetic user step and usage-only steps. Add an optional malformed-line diagnostic callback to the existing Claude/Codex normalizers; record selected-source read/normalization failures, retaining any successfully normalized evidence. A source error makes availability `errored`; no meaningful evidence is `unavailable`.

  Retry unavailable/errored capture using the existing finite retry count; a valid zero-tool refusal does not retry. Feed availability into strict Claude capture, Codex misplaced-log diagnostics, composer and transcript dispatch. Set the existing composer `captureEmpty` input from unavailable evidence instead of tool count; update its diagnostic wording to refer to unavailable transcript evidence. In transcript dispatch, return a broken result for unavailable evidence before calling the existing predicates, then pass `empty: false` for valid zero-tool evidence. Update both loader callers (`check/dispatch.ts` and `cli/check-transcript.ts`). Missing/invalid trajectory files remain unavailable even if an environment flag claims otherwise. Do not broaden this into repairs of unrelated normalizers.

  ```ts
  if (proc.error) throw proc.error;
  if (proc.signal !== null || proc.status === null) {
    return broken(`command-succeeds: child did not settle normally (${proc.signal ?? 'no status'})`);
  }
  if (proc.status === 126 || proc.status === 127 || proc.status >= 128) {
    return broken(`command-succeeds: checker exited ${proc.status}`);
  }
  if (proc.status === 0) return pass();
  // Keep the existing truncated ordinary-failure detail for other nonzero exits.
  ```

  This follows the existing check crash-band convention. The trusted pricing oracle in Task 5 catches subject syntax/import/assertion failures and exits 1; missing/killed checker machinery does not become an ordinary subject failure.
- [ ] **Run the task's tests, both normalizer test files, and `bun run typecheck`.** Verify ordinary existing QA capture still uses the same source selection and missing-transcript diagnostics. No check may convert an instrument failure into a pass through negation.
- [ ] **Commit capture/check corrections with the negative cases and their passing receipts.**

### Task 5: Define and retain the one pricing scenario

**Repository:** Q.

**Files:** Modify `src/story-meta.ts`, `src/scaffold.ts`, `src/contracts/verdict.ts`; create `src/runner/conversation-input.ts`, `src/contracts/conversation.ts`, `src/capture/output.ts`; create `scenarios/conversation-pricing/{story.md,setup.sh,checks.sh,checks-manifest.json,oracle.cjs,fixtures/src/pricing.js}`. Extend `test/story-meta.test.ts`, `test/scaffold.test.ts`, `test/contracts.test.ts`; create `test/conversation-input.test.ts`, `test/capture-output.test.ts`, `test/conversation-pricing.test.ts`.

**Interfaces:** Implement `quorumModeFromStory(story: string): 'qa' | 'conversation'`, `readQuorumMode(storyPath: string)` with the same return type, `projectConversationStory(story: string): {brief: string; rubric: string}`, and `snapshotConversationOutput(workdir: string, destination: string): string[]` returning retained relative paths. Add Zod schemas/types for the wire records above; add optional `conversation` to `FinalVerdictSchema` and optional `criteria` to `GauntletLayerSchema`, with the existing `{criterion, verdict, evidence}` shape.

- [ ] **Write failing projection/schema/output/oracle tests.** A marker unique to the ACs must be absent from `brief`; a marker unique to the user brief must be absent from the assessor's rubric description. Preserve frontmatter on the rubric so Gauntlet's existing parser can read it. Reject unknown mode, empty brief, missing AC marker and empty criteria. Test completed records missing an endpoint/reference, plus valid completed refusal. Snapshot tests use real directories and cover new helper/test files, later source edits, escaping symlinks and excluded `.git`/dependency trees.

  ```ts
  const story = '---\nid: p\ntitle: Pricing\nquorum_mode: conversation\n---\n'
    + 'PRIVATE_USER_FACT\n\n## Acceptance Criteria\n- PRIVATE_GRADE_RULE\n';
  const projected = projectConversationStory(story);
  expect(projected.brief).toContain('PRIVATE_USER_FACT');
  expect(projected.brief).not.toContain('PRIVATE_GRADE_RULE');
  expect(projected.rubric).toContain('PRIVATE_GRADE_RULE');
  expect(projected.rubric).not.toContain('PRIVATE_USER_FACT');
  expect(() => quorumModeFromStory(story.replace('conversation', 'unknown'))).toThrow();
  ```

  Oracle controls: unchanged module, one-code/one-price hardcoding, broken known discounts, missing file/export, syntax failure, runtime throw, and valid fixes in either internal function. Execute the actual trusted oracle against temporary output directories; assert process outcomes and results, not shell text. Include a module that writes a file during import and verify the preserved output is unchanged.
- [ ] **Run:** `bun test test/conversation-input.test.ts test/capture-output.test.ts test/conversation-pricing.test.ts test/story-meta.test.ts test/contracts.test.ts`. Expect new contracts/functions/scenario to be absent initially.
- [ ] **Implement scalar mode parsing and projection.** Follow `StoryMetaError` and the existing metadata readers. Only an absent key maps to `qa`; only explicit `conversation` is accepted. Validate it in `checkScenario` and later at the runner's existing story preflight. Projection strips the frontmatter from the brief and splits at `## Acceptance Criteria`. The rubric retains frontmatter and the complete AC section, with a neutral assessment description replacing the user brief. Reuse Gauntlet's AC parser on that projected rubric at assessment time; do not create another bullet parser or story language.

  The scenario's story has id `conversation-pricing`, status `ready`, `quorum_tier: adhoc`, and `quorum_max_time: 10m`. Its prose gives the opening in the spec, the private full-price policy and neutral question-answering preferences. Its two AC bullets require (1) obtaining and following the full-price/known-discounts policy, and (2) a delivery supported by output and verification evidence. Refusal or a bad delivery still ends the interaction. Do not require a skill, a particular internal function, a commit or a new test file.

  Seed the same `RATES`, `getDiscountRate` and `finalPrice` as the existing pricing module, without BUG/root-cause commentary. `setup.sh` uses `create_base_repo`, copies `fixtures/src/pricing.js` into the workspace and commits that file. Make setup executable and leave checks non-executable. Checks remain ordinary functions:

  ```sh
  # coding-agents: claude,codex
  pre() {
      requires-tool node
      file-exists src/pricing.js
  }
  post() {
      command-succeeds "test -r \"$QUORUM_SCENARIO_DIR/oracle.cjs\" || exit 127; exec node \"$QUORUM_SCENARIO_DIR/oracle.cjs\""
  }
  ```

  The outer checks shell expands the trusted script path; the nested command does not depend on `QUORUM_SCENARIO_DIR` surviving its restricted environment. Add a trusted-script preflight before conversation launch in Task 6. Keep generated manifest matching, including the existing wildcard-argument handling for expanded paths.

  `snapshotConversationOutput` copies ordinary workspace files into `evidence/output`; exclude `.git` and the existing dependency-pruning directory names. Preserve helper/test/docs files. Reject escaping links and special files as explicit capture errors; never follow a link into a HOME. For this small fixture there is no dependency installation or full repository reconstruction.

  The oracle creates a byte-identical execution copy of its cwd under the supplied private `TMPDIR`, and imports only that copy. The retained output is what the assessor reads. Keep scratch-copy setup/removal errors as checker errors; catch subject import/export/assertion errors as ordinary failure. Its assertion core is:

  ```js
  const assert = require('node:assert/strict');
  const rates = { SAVE10: 0.1, SAVE20: 0.2, HALFOFF: 0.5 };
  for (const price of [0, 37.5, 100]) {
    for (const [code, rate] of Object.entries(rates)) {
      assert.equal(finalPrice(price, code), price - price * rate);
    }
    for (const code of ['BOGUS', 'NOT_A_DISCOUNT']) {
      assert.equal(finalPrice(price, code), price);
    }
  }
  ```

  `finalPrice` is loaded from `<scratch copy>/src/pricing.js` inside the behavioral-error catch. Missing/invalid output exits 1 with a concise explanation. Oracle filesystem/setup failures exit 127; signals remain signals. Print a short matrix outcome for retained check evidence. No trusted oracle file is placed in subject output.
- [ ] **Generate only the new scenario's manifest:** `bun run quorum check conversation-pricing --update-manifests`. Run the task's tests, `bun run quorum check`, and `bun run typecheck`; verify the new scenario is valid and existing manifests are unchanged.
- [ ] **Commit the scenario, projection, snapshot and contracts with their tests.**

### Task 6: Run both roles inside one existing Quorum worker

**Repository:** Q.

**Files:** Create `src/runner/gauntlet-role.ts`, `src/runner/conversation.ts`; modify `src/runner/index.ts`, `src/runner/stopped.ts`, `src/cli/run-command.ts`, `src/composer.ts`; extend `test/runner-gauntlet-result.test.ts`, `test/runner-stopped.test.ts`, `test/composer.test.ts`; create `test/runner-conversation.test.ts`, `test/runner-gauntlet-role.test.ts`, `test/fixtures/conversation-role.ts`.

**Interfaces:** Implement the subprocess seam below. `GauntletRoleRecord` is the Task 5 contract, `ChildProcess` is the existing Node type. `runPreparedConversation` is a domain-specific continuation taking the already prepared runner inputs, not a public harness abstraction:

```ts
type RoleProcessArgs = {
  role: 'conversation' | 'assessment';
  binary: string;
  argv: string[];
  runDir: string;
  env: Readonly<Record<string, string | undefined>>;
  deadlineMs: number;
  shouldStop: () => boolean;
  socketPath?: string;
};
function invokeGauntletRole(args: RoleProcessArgs): Promise<GauntletRoleRecord>;
function currentRoleChild(): ChildProcess | null;
function stopActiveRole(signal: NodeJS.Signals): void;

type PreparedConversation = {
  runDir: string;
  scenarioDir: string;
  storyPath: string;
  launcherPath: string;
  workdir: string;
  launchCwd: string;
  runHomeDir: string;
  configDir: string;
  codingAgent: string;
  normalizer: 'claude' | 'codex';
  logDir: string;
  logGlob: string;
  snapshot: ReturnType<typeof snapshotDir>;
  checksSh: string;
  checksRepoRoot: string;
  preRecords: CheckRecord[];
  expectedChecks: CheckManifest | null;
  checkScratchRoot?: string;
  superpowers?: SuperpowersSpec;
  gauntletBin: string;
  graderModel: string;
  maxTime: string;
  envBase: Readonly<Record<string, string | undefined>>;
  shouldStop: () => boolean;
  identity: RunIdentity;
};
function runPreparedConversation(args: PreparedConversation): Promise<FinalVerdict>;
```

All other named types/functions above already exist in Q (`snapshotDir` in capture; check/manifest/verdict contracts; SuperpowersSpec; runner phase identity). The new mode is Linux Claude/Codex only. Resolve the normalizer to that union at mode validation rather than casting an unsupported harness.

- [ ] **Write failing subprocess and runner tests.** The executable test fixture parses the two role commands, records structured inputs, writes native refusal/delivery logs and the specified completion/result files, and supports explicit hang, signal and assessment-error cases. It makes no provider calls. Use the existing runner fake provisioning/environment seams and clean temporary homes.

  Test that the conversation command receives only the brief/launcher/workspace and selected controller model, while assessment receives rubric/index and the same model. A completed refusal plus an ordinary failing oracle must be final fail; conversation cleanup failure, capture failure, killed checker or assessment error must be indeterminate with the completed record retained. Incomplete conversation must never launch assessment. Criteria absent or inconsistent with overall pass must not pass. Check the actual assessor's process exit separately from the driver's.

  For deadlines, launch a real harmless fixture child that never settles; use a 100–200 ms role bound and assert settlement within a two-second test envelope. In a separate tmux test, keep a prepared subject waiting while the role hangs; timeout/cancel must remove the exact supplied socket/server. Start an unrelated private server and prove it survives. Include cancel before conversation, during conversation, between checks/assessment, and after completion while assessment is running.
- [ ] **Run:** `bun test test/runner-gauntlet-role.test.ts test/runner-conversation.test.ts test/runner-stopped.test.ts`. Expect missing new-mode handling and completion loss to fail.
- [ ] **Implement the subprocess owner.** Allocate a short private socket path under a temporary directory, owned only by this attempt. Start the deadline immediately when launching the child; it cannot depend on Gauntlet returning from a model/tool await. Drain both pipes, retain actual settled code/signal and record started/finished timestamps. Use the existing environment allowlist, adding only Quorum's prepared cwd/HOME for conversation. The assessment receives the same controller credential projection but no subject HOME/cwd overlay.

  On timeout or cancellation, record the cause, signal the exact role child and terminate the exact private tmux server. Use a short bounded grace followed by killing the still-active role process; clear timers/listeners in `finally`. The Gauntlet adapter's descendant cleanup remains the normal path; the existing attempt container termination is the final bound if cleanup itself fails. Never claim cleanup succeeded while a known role/runtime is still active. No provider client cancellation rewrite or process-name scan is required.

  Update CLI signal forwarding to call `stopActiveRole` when a new role is active and retain existing forwarding for the QA child. Make `currentGauntletChild()` expose the actual active role for existing observers. Preserve the existing runner-authoritative `runWasStopped()` behavior; a late signal after completion does not overwrite a settled verdict.

- [ ] **Implement the runner branch and finalization.** Validate mode at the existing story preflight. Reject non-Linux/non-Claude-or-Codex conversation runs before provision/launch. After current context substitution/prechecks, call `runPreparedConversation` instead of `invokeGauntlet` for the new mode. Do not supply the QA project prompt, HOWTO/context tree or original story to `converse`.

  The new continuation executes this fixed order:

  1. Project private inputs; allocate exact role output directories and role records. Verify the scenario's trusted oracle exists and is readable. Check cancellation before launch.
  2. Invoke conversation using the prepared absolute launcher, same configured controller model/credential, `maxTime`, and parent-owned socket. Read and validate `conversation.json`; absence after timeout/stop/error becomes that explicit incomplete record, never inferred completion. A role exit alone cannot establish an endpoint. A completed record followed by failed cleanup/nonzero conversation exit remains completed but produces a Gauntlet-stage instrument error; do not assess while subject shutdown is unconfirmed. The driver never returns a behavioral grade through its exit code.
  3. After subject shutdown, retain selected native logs, visible exchange and available trajectory. Snapshot output and build the exact evidence file list. Surface source normalization/copy errors. Incomplete interaction retains partial evidence and ends indeterminate without semantic assessment.
  4. Check cancellation. Run existing `runPhase(post)` against `evidence/output`, with private scratch, captured trajectory/availability and existing expected-check enforcement. Retain all pre/post records in `evidence/checks.json`. An ordinary failed oracle still proceeds to assessment; a checker crash ends indeterminate with its records retained.
  5. Check cancellation. Start assessment against the private rubric and exact evidence index with a 120,000 ms parent bound. Read only its allocated result file, preserving criteria. Attach only this child's actual `process_exit` to `gauntlet`; missing result synthesizes an inconclusive assessor result naming this child's failure.
  6. Compose using the existing final/check/manifest/exit-code rules. Add the recorded conversation. Inconclusive assessment copy says “Assessment inconclusive,” never that the subject did not complete. Required capture/checker/assessor errors win over a behavioral verdict and retain the failing stage.

  An observed cancellation starts no further execution/check/assessment phase. Finalization may retain already produced files and completion/process facts. Timeout before an endpoint similarly cannot trigger semantic grading. Keep phases within the existing `setup | agent | checks` vocabulary for this slice; role records identify the two agent invocations without expanding dashboard behavior.

  At the outer `runScenario` final-verdict write, attach the valid persisted conversation even when the inner function threw. If the new continuation returns a verdict with `error.stage === 'stopped'`, set `runStopped = true` there so the existing CLI stop path observes it. Update `writeStoppedVerdict` to retain this same record and available existing checks/assessment/economics instead of blindly erasing them. Neither writer replaces `completed` with `stopped` because a later phase was cancelled.

- [ ] **Run the task's tests and focused QA regression tests:** `bun test test/runner-gauntlet-role.test.ts test/runner-conversation.test.ts test/runner-stopped.test.ts test/runner-gauntlet-exit.test.ts test/runner-gauntlet-result.test.ts test/runner-e2e.test.ts test/composer.test.ts test/composer-manifest.test.ts`. Expect unchanged old-mode behavior, exact role exit attribution, explicit error outcomes and preserved completion. Run `bun run typecheck`.
- [ ] **Commit the complete worker flow and its tests.** Explain the phase order, parent-owned timeout/cleanup and unchanged campaign ownership.

### Task 7: Count both roles and finish the standard per-run readout

**Repository:** Q, with final checks in both repositories.

**Files:** Modify `src/economics.ts`, `src/cli/render.ts`, `docs/scenario-authoring.md`, `docs/appliance-runbook.md`; extend `test/economics.test.ts`, `test/cli-render-economics.test.ts`, `test/runner-campaign-publication.test.ts`, `test/runner-conversation.test.ts`; add `test/cli-render-conversation.test.ts`. Make a narrow `src/runner/index.ts` finalization adjustment if necessary to attach economics on every new-mode outcome.

**Interface:** Keep `buildRunEconomics(runDir, sidecarEstimator)` and its existing aggregate fields. Add optional `roles` to its Gauntlet block:

```ts
type GauntletRoleEconomics =
  | { status: 'not_run'; usage: null; duration_ms: null }
  | { status: 'started'; usage: TokenUsage | null; duration_ms: number | null };
// roles, when present:
// { conversation: GauntletRoleEconomics; assessment: GauntletRoleEconomics }
```

`TokenUsage` and `SidecarEstimator` are existing Q types. Role records identify exact usage paths and actual starts; do not infer “not run” from a missing sidecar. Ordinary QA runs keep their existing single-role accounting path.

- [ ] **Write failing accounting/readout tests.** Give the existing estimator seam two distinguishable priced sidecars, then assert their exact token/model/cost sums in the existing Gauntlet aggregate. Remove each started role's sidecar in turn: total coverage must become partial, total complete cost null, and the known sibling's amount remain visible. A never-started assessment must be `not_run`, not missing usage. Include an unpriced model and a started role interrupted before its first response.

  ```ts
  expect(economics.gauntlet?.est_cost_usd).toBe(0.3); // role costs 0.1 + 0.2
  expect(economics.gauntlet?.roles?.conversation.status).toBe('started');
  expect(economics.gauntlet?.roles?.assessment.status).toBe('started');
  // Rebuild after the started assessment's usage is removed:
  expect(partial.partial).toBe(true);
  expect(partial.total_est_cost_usd).toBeNull();
  expect(partial.gauntlet?.roles?.conversation.usage?.est_cost_usd).toBe(0.1);
  ```

  Set these artifacts up with temporary run directories and explicit `GauntletRoles`, using the existing economics test usage fixtures. Renderer tests assert the semantic labels, completion/endpoint and criterion evidence, not a full text snapshot. Publication tests add the new evidence/role files to an ordinary worker artifact fixture and read them through the existing attempt manifest/publisher; campaign identity and verdict exit mapping must still validate.
- [ ] **Run:** `bun test test/economics.test.ts test/cli-render-conversation.test.ts test/runner-campaign-publication.test.ts`. Expect missing role accounting/readout coverage to fail initially.
- [ ] **Implement accounting and rendering.** Price each started role's exact `usage.jsonl` with `SidecarEstimator`, preserve the per-role `TokenUsage`, and sum known fields into the existing Gauntlet block. Sum matching model buckets, unpriced-model sets and approximation records; retain the existing rounding convention. Do not pass `TokenUsage[]` to `mergeEstimates`, which accepts Obol `CostEstimate[]`. Use a small local fold over the two role usages. Missing started-role usage makes aggregate cost incomplete even when another role is priced; never represent it as a free role.

  Attach economics during common new-mode finalization, including failed assessment and cancellation. Render the conversation status/endpoint and completion evidence, then **Assessment**, its actual criterion verdicts/citations, deterministic checks and existing cost totals. Keep the existing outer schema/version, campaign identity, manifest generation and return codes. Do not add a batch renderer, dashboard or campaign-policy change.

  Document the scenario selector, private brief/AC split, generated-launcher ownership, retained files, separate roles, 10m/2m bounds and completed-bad-output behavior. Update the appliance runbook's artifact list; it still submits and polls current finite work. State that campaign aggregates retain their current validity policy and that this increment does not establish a speedup or capacity level.
- [ ] **Run focused tests, then each repository's required checks once.** In Q: `bun run check` and `bun run quorum check`. In G: `bun run check`. Confirm the real terminal tests ran; report environmental failures or skips explicitly. Re-run only checks affected by subsequent fixes. No live scenario, Docker job, provider call or appliance launch is part of these commands.
- [ ] **Commit the readout/accounting/docs with passing receipts.** Record the two implementation SHAs together in the handoff; the appliance source snapshot already pins both repositories. No source-snapshot schema change is necessary.

## Completion and next evidence

Offline completion means one automated path proves a real terminal question/answer, independent assessment, meaningful passing/failing output controls, message-only refusal, required evidence errors, both-role accounting, and cancellation/hung-role cleanup. Mocked model responses prove the machinery; they do not prove a real model plays the user or assessor well.

The next artifact after implementation is a short finite appliance run plan: select supported Claude/Codex credential routes and explicit model revisions, inspect one run on each, then overlap copies within and across harnesses. Specify sample counts, spend/time bounds and stop conditions there. Use the existing appliance submit/status/cancel path. Decide whether the interaction and assessment are useful before any broader migration, campaign simplification or concurrency tuning.

## Plan self-review

| Spec requirement | Implementation / evidence |
|---|---|
| Natural user with almost no authored exchange; exact live harness | Tasks 1–2; prose-only Task 5 fixture |
| Private criteria and separate histories/tool permissions | Tasks 2–3 and input projection in Task 5 |
| Completion independent of quality and later errors | Tasks 2, 5–6; refusal and stopped-writer tests |
| Same retained output checked and assessed | Tasks 5–6; scratch-copy mutation control |
| Usable zero-tool evidence; lost sources cannot prove absence | Task 4 native/capture/check tests |
| Actual assessor criteria and process exit | Tasks 3 and 6; contradiction and distinct child-exit cases |
| Both role costs, missing usage and not-run distinction | Task 7 |
| Hard role deadlines and current appliance ownership | Task 6; exact socket cleanup and unchanged campaign tests |
| Standard per-run result without platform expansion | Tasks 6–7; existing contracts and publication |
| Live model behavior and concurrency proof | Finite run plan after implementation; no live evidence claimed here |
