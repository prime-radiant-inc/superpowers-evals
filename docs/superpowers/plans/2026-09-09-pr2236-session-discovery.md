# Session Discovery Pilot Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prepare and run the approved six-evaluation comparison of the PR's
session references against shared discovery on Claude, Codex, and Pi.

**Architecture:** Keep the existing quorum setup, isolated homes, capture,
checks, and appliance campaign execution. Add one scenario, narrow experiment
helpers for fixture installation and retained-evidence checking, and six pinned
arms. Independently inspect the six outputs after execution; do not depend on
the unfinished conversation/assessment implementation or build a new service.

**Tech Stack:** TypeScript, Bun, existing shell scenario DSL, YAML campaign
declarations, the native Claude/Codex/Pi session formats, and prose skill files.

**Spec:** [Approved discovery pilot](../specs/2026-09-09-pr2236-session-discovery-design.md).

## Global Constraints

- "The first execution is a six-run pilot: one discovery task, Claude/Codex/Pi, one before/after pair per harness."
- "Additional cases and repetitions are deferred until the pilot is reviewed."
- "There is no separate paid qualification batch."
- "Set reserve capacity to zero and permit one attempt per arm/case."
- "Do not combine the entire case catalog into six long sessions."
- "Any fixture-generation calls are separately declared and accounted for, rather than hidden in the six-run count."
- The control's normative skill bytes come from PR head `801badbf719f4044c97175e5b01fb6f7cbc32c2d`.
- Superpowers stays a prose-only, zero-dependency skill. Experiment utilities belong in Evals.
- Use existing Linux appliance execution for shared live runs. Keep raw histories and answer keys private until independently reviewed for publication.
- Stop this implementation at the six-run readout. Do not automatically admit retries, additional harnesses, or challenge cases.

## Execution setup and source facts

Use the worktree skill before implementation to isolate changes in both Evals
and `/Users/drewritter/prime-rad/superpowers`. Preserve the unrelated untracked
`test/conversation-reliability-operator.test.ts` in the original Evals workspace.
Read the Superpowers checkout's `CLAUDE.md` and `writing-skills` before editing
the treatment. The six-run pilot is the initial behavioral comparison, not a
claim that all of that repository's release evaluation requirements are met.

The following existing behavior was inspected while preparing this plan:

- `src/runner/index.ts` provisions the home, calls `runSetup`, then takes the
  session-log snapshot. Setup already receives `QUORUM_CODING_AGENT` and
  `QUORUM_CODING_AGENT_HOME`. No runner environment extension is needed.
- Checks receive `QUORUM_AGENT_CONFIG_DIR`, `QUORUM_CODING_AGENT`, and
  `QUORUM_RUN_DIR`. `command-succeeds` can invoke a narrow experiment CLI.
- `src/capture/index.ts` selects logs created after the setup snapshot.
  Pre-existing fixture files must be excluded from evaluation usage.
- `src/campaign/container-spawner.ts` mounts the Evals and Superpowers source
  trees read-only. A read-only file is still visible to the subject: do not put
  the answer key in either mounted tree.
- The PR's development plan embeds the removed references. Package both arms
  without development docs/tests/history, and distinguish original source
  commits from the runtime package commits registered with the appliance.
- `test/fixtures/claude-2.1.177-real.jsonl` lacks the completed tool exchange;
  `codex-56-exec.slice.jsonl` lacks the human request. These slices alone cannot
  serve as the pilot's target histories. Treat `pi-session.slice.jsonl` as a
  format/test reference until its native provenance is established.

## File map

| Location | Responsibility |
|---|---|
| Superpowers `skills/diagnosing-superpowers/` | Shared discovery treatment and updated consumers |
| Superpowers `tests/diagnosing-superpowers/test-skill-structure.sh` | Active-file structure after reference removal |
| Evals `src/experiments/session-discovery-fixtures.ts` | Install neutral native histories and collect them after the subject stops |
| Evals `src/cli/session-discovery-fixtures.ts` | Setup/post-check command entrypoint |
| Evals `src/experiments/session-discovery-evidence.ts` | Pure checks over retained output, source records, and a private answer key |
| Evals `src/cli/session-discovery-evidence.ts` | Offline evidence-check command; never used to expose the answer key inside the subject container |
| Evals `test/session-discovery-fixtures.test.ts` and `test/session-discovery-evidence.test.ts` | Hermetic fixture/capture and adversarial checker tests |
| Evals `scenarios/diagnosing-session-discovery/` | One discovery task, setup, post checks, generated checks manifest |
| Evals `scripts/experiments/pr2236-package.ts` | Build two equivalent runtime package refs without reference copies/history |
| Evals `test/pr2236-package.test.ts` | Verify byte parity and exposure boundaries of both packages |
| Evals `arms/pr2236_{claude,codex,pi}_{before,after}.yaml` | Six immutable runtime configurations |
| Evals `suites/pr2236_session_discovery.yaml` | Three comparisons, one repetition each, no reserves/retries |
| Evals `docs/experiments/2026-09-09-pr2236-session-discovery.md` | Preregistration, provenance, operational limits, and later readout |

The private pilot directory lives outside the appliance's mounted source trees.
It holds the reviewed native inputs, answer key, source-to-runtime provenance,
and evidence assessments. Public source contains no file called `target.jsonl`
or metadata that identifies which historical session is the answer.

### Task 1: Qualify and install one native discovery fixture per harness

**Files:** Create the fixture helper, its CLI, and
`test/session-discovery-fixtures.test.ts`. Add neutral fixture files beneath
`scenarios/diagnosing-session-discovery/history/{claude,codex,pi}/` only after
their content and provenance are reviewed. Put provenance with answer-bearing
details in the private pilot directory.

**Interfaces:**

```ts
export type DiscoveryHarness = 'claude' | 'codex' | 'pi';
export interface HistoryInstall {
  agent: DiscoveryHarness;
  home: string;
  workdir: string;
  sourceDir: string;
}
export interface HistoryFile {
  relativePath: string;
  sha256: string;
}
export function installHistory(args: HistoryInstall): HistoryFile[];
export function collectHistory(
  args: HistoryInstall & { outputDir: string },
): HistoryFile[];
```

- [ ] **Select complete native inputs.** For each harness, inspect bounded
  records from available reviewed histories. Require session identity, an actual
  human request, and a complete tool call/result establishing a small factual
  outcome. Use the same target bytes in both arms. Keep two plausible decoys;
  document any sanitized or constructed decoy transformations. If complete
  native inputs are missing, enumerate the required fixture-generation calls
  and their cost allowance before making any such calls.
- [ ] **Write the private answer key.** Record the source hash, target session
  id, remembered cue/time window, actual human requests, the factual outcome,
  and the exact call/result evidence locations. Verify the known operation
  independently where it is reproducible. Do not manufacture successful tool
  output to complete a partial native slice.
- [ ] **Write failing installer tests.** The tests may use explicitly synthetic
  records to test filesystem behavior; those records are not measured histories.
  Include all three normal store layouts and a provisioned authentication
  sentinel. The installer must preserve existing configuration and auth bytes.

```ts
test.each(['claude', 'codex', 'pi'] as const)(
  '%s preserves provisioned files and installs three histories',
  (agent) => {
    const f = makeInstallFixture(agent);
    try {
      const files = installHistory(f.args);
      expect(files).toHaveLength(3);
      expect(readFileSync(f.authPath, 'utf8')).toBe('auth-sentinel');
      expect(readdirSync(f.args.workdir)).toEqual([]);
      const snapshot = snapshotDir(f.logDir, '**/*.jsonl');
      expect(snapshot.size).toBe(3);
      expect(newFilesSince(f.logDir, '**/*.jsonl', snapshot)).toEqual([]);
    } finally {
      rmSync(f.root, { recursive: true, force: true });
    }
  },
);
```

  Define `makeInstallFixture` in this test file: allocate a temporary root,
  create `home`, an empty `workdir`, a neutral three-file corpus, and the auth
  sentinel; return those paths plus the harness's log root. Never use the
  operator's real home. Run `bun test test/session-discovery-fixtures.test.ts`
  and confirm the missing implementation fails.
- [ ] **Implement installation and collection.** Resolve Claude beneath
  `.claude/projects`, Codex beneath `.codex/sessions`, and Pi beneath
  `.pi/agent/sessions`, using the verified native layout of the selected inputs.
  Preserve native ids and linkages; record any path sanitation. Copy only regular
  corpus files, rejecting paths that escape the source or destination. The
  tester's installation mappings are never copied into the skill treatment.
  The setup CLI accepts `install`; post-check collection accepts `collect`.
  Read environment through `src/env.ts`, as other CLIs do.
- [ ] **Complete the collection regression.** Create a new evaluation log after
  `snapshotDir`; verify capture selects that new log and excludes the three
  histories. Modify one installed history and verify collection detects the
  mismatch. Collect only the historical evidence under the workdir after the
  Coding-Agent has stopped; never copy auth or the entire home.
- [ ] **Run the fixture tests and commit this deliverable.** The private answer
  key remains outside Git and every worker mount.

### Task 2: Implement the shared prose treatment and clean runtime packages

**Files:** Superpowers `SKILL.md`, `templates/case.md`,
`prompts/analyst-common.md`, `prompts/cost-and-time.md`, a new
`references/session-discovery.md`, and the existing structure test. Remove
`references/{claude-code-sessions,codex-sessions,other-harnesses}.md`.
In Evals, create `scripts/experiments/pr2236-package.ts` and its test.

**Interfaces:** Two reviewed source commits and two runtime package commits.
The package receipt contains `source_sha`, `runtime_sha`, and a sorted list of
`{ path, sha256 }` for every installed regular file. It contains no reference
contents or private fixture answers.

- [ ] **Implement the treatment on the pinned PR head.** Use this shared prose
  as the initial candidate, preserving the skill's surrounding voice:

```markdown
# Discover the session history

Resolve the session your human partner named using the tools and information
available in this environment. Your knowledge can suggest where to look; verify
the result against the actual history.

Use the harness's exposed session tools, configured storage, local help,
documentation, or bounded filesystem inspection. Measure files before reading
their content and follow context-safety.md. Inspect archives or indexes when the
environment points to them. A supplied usable path does not need another search.

Confirm identity using the available session id, working directory, timestamps,
and matching conversation content. Recency alone is not confirmation. Distinguish
the requested session from its children and unrelated candidates. Ask for a
missing identifying fact when the available evidence cannot distinguish them.

Establish the record meanings needed for the requested investigation from
observed records or documentation. Distinguish human messages from injected
messages, tool results, and a parent agent's dispatch. Match tool calls to their
results. Establish usage-counter semantics before calculating totals. Do not
infer a format from another harness or turn a missing field into a zero.

Record the exact sources, relevant field meanings, supporting record locations,
associated sessions, rejected plausible candidates, and unresolved information
in the case file. Subsequent readers use that record rather than repeating
discovery. If history is missing, inaccessible, or ambiguous, state the specific
limitation and ask for the missing path, export, or identifying detail.
```

- [ ] **Update every active consumer.** Route Locate to the new reference.
  Replace the case template's harness-reference choice with a discovered-sources
  and record-meanings section. Make the analyst preamble consume that section.
  In cost/time guidance, ask for evidenced counter and timing semantics instead
  of retaining Claude/Codex field names. Search the entire skill for dangling
  references and remaining format-specific recipes. Preserve unrelated workflow
  rules and do not introduce bundled scripts.
- [ ] **Update and run the structure test.** It must require the new reference
  and reject the three removed files or dangling active references. Run
  `bash tests/diagnosing-superpowers/test-skill-structure.sh` in the treatment
  checkout. Commit the treatment; retain the original PR head as the control's
  normative source.
- [ ] **Write package tests before the packager.** Test that the control package
  preserves the original active skill bytes, the treatment contains no removed
  references, and both omit development `docs/`, `tests/`, and `.git` history.
  Include a development-plan fixture containing a copy of the removed text so
  the test fails if packaging accidentally retains it. Preserve plugin manifests,
  hooks, runtime libraries, and active skill-relative references.
- [ ] **Implement the packager.** Export each source commit with `git archive`
  into a new temporary directory; remove the same development-only paths from
  each export; inventory the remaining regular files; reject escaping symlinks.
  Create a fresh runtime-package root commit from each export so its history
  cannot recover deleted reference text. Import those package commits into the
  configured Superpowers checkout's object database for ordinary arm resolution.
  Record source/runtime relationships outside the subject package. Never modify
  a campaign's already frozen snapshot.
- [ ] **Verify package parity offline and commit the Evals packager.** Confirm
  both packages pass their applicable plugin/structure checks. The original PR
  head and treatment source SHA remain the research identities; runtime package
  SHAs are the values used in arm `superpowers` fields.

### Task 3: Add the single scenario and independent evidence checks

**Files:** Create `scenarios/diagnosing-session-discovery/story.md`, `setup.sh`,
`checks.sh`, and generated `checks-manifest.json`; create the evidence helper,
its offline CLI, and `test/session-discovery-evidence.test.ts`.

**Interfaces:**

```ts
export interface DiscoveryCitation {
  relativePath: string;
  line: number;
  quote: string;
}
export interface DiscoveryAnswerKey {
  harness: 'claude' | 'codex' | 'pi';
  targetSessionId: string;
  targetRelativePath: string;
  humanRequests: string[];
  expectedFact: string;
  allowedEvidence: DiscoveryCitation[];
}
export interface ExtractedDiscoveryAnswer {
  sessionId: string | null;
  sourcePath: string | null;
  humanRequests: string[];
  fact: string | null;
  citations: DiscoveryCitation[];
}
export interface DiscoveryCheck {
  check: string;
  passed: boolean;
  detail: string;
}
export function checkDiscoveryAnswer(
  answer: ExtractedDiscoveryAnswer,
  key: DiscoveryAnswerKey,
  readLine: (relativePath: string, line: number) => string | undefined,
): DiscoveryCheck[];
```

The answer remains ordinary subject prose/tables. An independent reviewer
transcribes its claims into `ExtractedDiscoveryAnswer`, retaining citations back
to that output. Never require the treatment's internal layout from the control.
The pure checks verify the extracted claims; a separate manual reading checks
the extraction and entailment. Record disagreements rather than resolving them
with a permissive regex.

- [ ] **Write adversarial checker tests.** Provide a small inline answer key and
  a `Map`-backed `readLine` in this test file. A correct answer must pass; a decoy
  id, injected text added as a human request, nonexistent citation, false quoted
  result, and existing-but-irrelevant citation must fail the appropriate check.
  Missing output is a behavioral failure; missing expected source data is an
  assessment error. Run `bun test test/session-discovery-evidence.test.ts` and
  confirm red before implementing the helper.

```ts
const wrongTarget = { ...correctAnswer, sessionId: 'decoy-session' };
expect(checkDiscoveryAnswer(wrongTarget, key, readLine)
  .find((r) => r.check === 'target-session')?.passed).toBe(false);
const wrongQuote = {
  ...correctAnswer,
  citations: [{ ...key.allowedEvidence[0]!, quote: 'invented result' }],
};
expect(checkDiscoveryAnswer(wrongQuote, key, readLine)
  .some((r) => !r.passed)).toBe(true);
```

- [ ] **Implement the pure checks and offline CLI.** The CLI accepts explicit
  retained-answer, answer-key, and historical-evidence paths from the operator.
  It runs outside the subject container after completion, emits check records,
  and never invokes or steers the Coding-Agent. Reject evidence paths escaping
  the retained history directory. Save the reviewer extraction and mechanical
  result beside the private answer key.
- [ ] **Write the story from the qualified fixture cue.** Use one exact opening
  per harness fixture, identical in its before/after pair. The request names the
  remembered cue/time window, asks for identity/path, actual human requests and
  the supporting tool fact, explicitly invokes the installed diagnosis skill,
  and stops its scope at discovery. Include the sentence:

  > Use diagnosing-superpowers only to locate and inspect the session. Give me
  > the session id and path, what I asked, and the tool action and result that
  > establish the answer, with source locations. Stop there without running the
  > full diagnosis.

  Derive the remembered cue from the real native target; do not substitute the
  session id or path. Keep the correct answer out of `story.md`. Give the
  Gauntlet-Agent neutral responses and a stop condition at delivery/limitation.
  Its ACs cover delivery/exposure mechanics only. The independent offline
  result, not the driver's self-grade, decides discovery correctness.
- [ ] **Wire the existing setup/post seams.** `setup.sh` invokes the fixture CLI
  with `install` using the already supplied coding-agent/home variables, then
  prepares a clean tiny workdir. `post()` checks skill exposure and invokes
  `collect` after the subject stops, using `QUORUM_AGENT_CONFIG_DIR` to locate
  the harness's home. Derive the home by its configured subdirectory rather than
  assuming the campaign's run directory and attempt directory are identical.
  Write the curated historical evidence into the workdir for publication. Do
  not install the answer key or output inventory into the workdir before the run.
- [ ] **Test actual setup/capture/collection integration.** Exercise `runSetup`
  with an isolated home, then the real snapshot/new-log selection and collection
  path. Assert seeded histories do not enter `trajectory.json` or usage; a newly
  written evaluation log does. Check collected histories preserve their bytes.
  Verify the packaging/mount inventory excludes the private answer key.
- [ ] **Generate the check manifest and commit the scenario/checker.** Set setup
  executable and checks non-executable. Run
  `bun run quorum check diagnosing-session-discovery --update-manifests`, then
  the ordinary validation command without the update flag.

### Task 4: Freeze the six-run configuration and verify preparation

**Files:** Create six `arms/pr2236_*.yaml` files,
`suites/pr2236_session_discovery.yaml`, and the dated experiment entry. Add
`test/pr2236-pilot-config.test.ts` to verify this exact experiment's finite size.

**Interfaces:** All `superpowers` values are full runtime package SHAs produced
by Task 2; the experiment entry also records their normative source SHAs.
No unresolved symbolic ref or placeholder enters a runnable arm declaration.

- [ ] **Create paired arms using existing credential routes.** Use
  `opus_bedrock` for both Claude arms, `openai_responses_56sol` for both Codex
  arms, and `pi_gpt56_sol` for both Pi arms. Use `high` effort for Claude/Codex
  and omit the unsupported arm effort field for Pi. These are initial controlled
  choices, not a model ranking. Record the effective Pi setting and pinned CLI
  versions from the selected runtime. If a route is unavailable, present a
  concrete replacement pair before launch; never change only one side.
- [ ] **Write this suite and verify its expansion.**

```yaml
schema_version: 2
name: pr2236_session_discovery
reserve: 0
max_exposure_skew: 60
attempt_bounds:
  max_attempts: 1
  max_time_s: 600
grader:
  credential: sonnet5
  model: claude-sonnet-5
comparisons:
  - baseline: pr2236_claude_before
    treatment: pr2236_claude_after
    scenarios: [diagnosing-session-discovery]
    n: 1
  - baseline: pr2236_codex_before
    treatment: pr2236_codex_after
    scenarios: [diagnosing-session-discovery]
    n: 1
  - baseline: pr2236_pi_before
    treatment: pr2236_pi_after
    scenarios: [diagnosing-session-discovery]
    n: 1
```

  Set the scenario's `quorum_max_time` to `8m` so the ten-minute outer attempt
  bound includes startup and final capture/checks. Keep the global launch cap
  at two for the pilot. Verify actual admission can cover all three harnesses;
  do not turn a missing credential or unsupported platform into a skill failure.
- [ ] **Add finite-size tests.** Load the actual YAML with the existing schemas.
  Follow registration's input split: validate `grader` with `GraderSchema` from
  `src/contracts/campaign/experiment.ts`, and validate the remaining fields
  with `SuiteSchema` from `src/contracts/campaign/suite.ts`.
  Assert three comparisons, matching harness/credential/effort in every pair,
  distinct before/after refs, `n: 1`, zero reserve, and one attempt. Assert the
  planned evaluation count is exactly six and no deferred scenario is included.
- [ ] **Preregister the operational record.** Include fixture provenance/hashes,
  normative/runtime skill SHAs and manifests, Evals/Gauntlet/image versions,
  model settings, the exact public prompts, independent assessment method, and
  six-row result table. Keep raw sources/keys private. State that the pilot can
  establish examples and obvious regressions but no reliability rate.
- [ ] **Run meaningful offline verification.** Run the new fixture/evidence/
  package/config tests, `bun run check`, and `bun run quorum check`. Inspect
  the installed package and fixture inventory through the prepared Linux
  container without a model call. Verify no answer key, copied references,
  or accessible package history compromises the treatment. Record failures
  and fix the concrete cause before live execution.
- [ ] **Commit a reviewable launch manifest.** Resolve the spending allowance
  against this prepared six-run configuration, including any declared fixture
  generation. The current conversation approves the experiment's scope; it
  supplies no numerical spending allowance. Request only this remaining
  operational input after the preparation is complete, rather than another
  approval of the design. The appliance's time/attempt bounds are not a dollar
  ceiling. Do not make paid calls while this required value is absent.

### Task 5: Execute once, independently read all six results, and stop

**Files:** Update the dated experiment entry with canonical campaign/attempt
pointers, the independently checked outcomes, complete costs, and recommendation.
Keep native logs, answer keys, and assessments in the private evidence directory.

- [ ] **Launch through the installed helper.** Use the configured appliance's
  read-only health check, register `suites/pr2236_session_discovery.yaml` with
  global cap two, and verify the frozen registration represents six attempts
  with the intended sources. Consume its single `campaign run` launch. Use the
  existing status/costs/cancel commands for observation and exact termination.
- [ ] **Retain all outcomes.** A timeout, setup error, unexposed skill, modified
  source, or missing capture stays visible and consumes its planned attempt.
  No replacement campaign or automatic retry is part of this task.
- [ ] **Assess the six outputs independently.** First read without the before/
  after label when practical. Extract the delivered claims, check them against
  the private answer key with Task 3, and manually verify citations and search
  behavior. Audit access to excluded guidance or answer-bearing files. Keep
  raw quorum verdicts distinct from the discovery assessment.
- [ ] **Record the comparison and all costs.** Show one before/after row for
  Claude, Codex, and Pi, including incorrect/inconclusive outcomes. Report
  discovery latency, tools, usage/cost where available, all-attempt totals,
  and setup/assessment coverage. Avoid averaging away a single-harness failure.
- [ ] **Deliver the readout.** State what succeeded, what regressed, what could
  not be measured, and whether shared discovery is viable on the ordinary task.
  Suggest at most the next targeted check justified by these results. End here;
  additional cases or repetitions require a new decision after this readout.

## Plan self-review

- Scope: one ordinary past-session task, six evaluations; full diagnosis and
  challenge cases remain deferred.
- Before/after: all three harnesses have both arms; Pi compares the existing
  generic procedure with the shared replacement.
- Evidence: native target histories are qualified before use; injected/tool
  records, wrong-target answers, irrelevant citations, exposure, and fixture
  preservation have concrete checks and independent reading.
- Isolation: existing setup/snapshot ordering is reused; private answers stay
  outside worker mounts; runtime packages omit deleted-reference copies/history.
- Accounting: historical fixtures are excluded from new-session usage; every
  attempted evaluation, setup call, and assessment remains accounted for.
- Execution: no platform redesign or extra paid smoke; missing runtime inputs
  are resolved against a concrete prepared configuration before the six runs.
