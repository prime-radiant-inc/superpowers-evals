# Conversation Reliability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox syntax for tracking.

**Goal:** Preserve failed-run evidence, qualify Pi startup, correct assessor error feedback, and test one bounded simulated-user/assessor correction.

**Architecture:** Keep current Quorum workers, credentials, scheduler, scenario format and publication schemas. Use isolated task worktrees and independent reviews. Root alone integrates sources and operates the appliance; experimental candidates have separate promotion gates.

**Tech Stack:** TypeScript, Bun 1.3.14, generated Bash launchers, Gauntlet Anthropic SDK, existing appliance helper and evidence readers.

**Spec:** `docs/superpowers/specs/2026-09-08-conversation-reliability-design.md`.

## Global Constraints

- Q baseline `e15ccead6ef265fb3133f86d7e9a3c3222847bcf`; G baseline `6dac4bfcb16042cb277067bb4535f9f22b9bb5df`. Preserve old experimental branches, reports, rubrics and failed attempts.
- Work only in assigned task worktrees. No worker providers, SSH, pushes, merges or subagents. Root provides independent review. Separate worktrees permit the two approved tracks to progress in parallel without shared writes.
- No manifest/report schema, sealing, scheduler or credential-policy change. No new generic runner, evaluator API, salvage, argument coercion, voting, retry framework or deadline increase.
- Tests must fail for real behavior. Use structured API assertions and actual filesystem/subprocess boundaries; no rendered-command or prompt-wording snapshots. Prompt-only semantics require retained/fresh evidence gates, not a passing fake client.
- Pi is Linux-only and eligible only for conversation pricing and code review; reuse `pi_gpt56_sol` without effort. Capture remains based on native header cwd and recursive JSONL discovery.
- One new assessor prompt candidate; preserve the prior frozen candidate. Freeze sources and expectations before new calls. At most24 retained calls, two repetitions per case, known before constructed controls, two minutes per call, one shared 90-minute retained window. Stop failed gates; no replacement cases or second candidate.
- At most8 fresh conversations; ten-minute conversations,900-second attempts, globalcap4. Fresh provider allocation$20: $8 retained assessment/$12 conversations, no transfer. Stop affected work on missing/unpriced usage or instrument failure; preserve unknown billing. Four-hour live window from first call, with cleanup headroom.
- Root may integrate independently passing pieces directly to main without PRs and deploy through the canonical helper after live workers stop. Failed semantic/Pi gates leave those changes unpromoted. Required checks, independent review, installed verification and final-main CI remain separate evidence.

### Task 1: Publish recursively empty failure trees

**Files:** Q `src/campaign/attempt-publish.ts`, `test/campaign-attempt-publish.test.ts`.

**Interfaces:** Preserve `publishAttempt`, `publishExecution`, `writeAttemptManifest` and `readAttemptEvidence`. Consume the existing files/symlinks-only manifest and stopped-worker identity. Return existing authenticated artifact references.

- [ ] Read the current publisher and the existing V2 publication fixture. Add an errored-conversation fixture with nonzero available grader usage, null subject cost, partial economics, and `gauntlet-agent/results/allocated/` containing only directories. Generate its real manifest, then call the real publisher and evidence reader.

```ts
// Use existing fixture identity/builders, not a new report shape.
mkdirSync(join(runDir, 'gauntlet-agent/results/allocated'), { recursive: true });
writeAttemptManifest(runDir, identity);
// Publish with the existing V2 stopped/bound identity, then assert the
// returned references authenticate the original errored verdict and usage.
```

- [ ] Run `bun run test test/campaign-attempt-publish.test.ts test/runner-manifest.test.ts test/runner-campaign-publication.test.ts`; record the new failure at the nested empty results directory.
- [ ] In the unlisted-directory fallback of `verifyInventory`, use its existing recursive walker. Keep the symlink check before recursion, all listed-file checks and every other publication contract.

```ts
if (stats.isDirectory()) {
  walk(fullPath, relativePath);
  continue;
}
throw refusal(`unlisted artifact refused: ${relativePath}`);
```

- [ ] Add nested unlisted zero-byte-file and symlink cases inserted after manifest generation. Both must still refuse, preserve staging and leave publication absent. Keep existing tamper, special-file and identity tests.
- [ ] Verify real rename and `readAttemptEvidence`: publication valid, outcome indeterminate, available grader cost/tokens retained, absent subject cost still null. Run focused tests, typecheck and lint; self-review and commit.

### Task 2: Use an explicit private Pi session directory

**Files:** Q seven-file patch `bce57431^..bce57431`, plus `coding-agents/pi-context/launch-agent`, `coding-agents/pi-context/HOWTO.md`, `coding-agents/pi.yaml`, `src/agents/pi.ts`, `test/agent-pi.test.ts`; add `test/fixtures/pi-session-launch.ts` if needed for the actual filesystem boundary.

**Interfaces:** Reuse `homeEnvSubstitutions()`'s `$QUORUM_AGENT_HOME_SH`, `populateContextDir`, `runScenario`, Pi provisioning, existing capture glob and native header filtering. No new launcher substitutions or credential fields.

- [ ] Carry only the previously reviewed seven-file Pi admission patch from `bce57431`; never copy the old whole worktree. Preserve the original commit/failed run. Review its tests before extending them.
- [ ] Replace the fake Pi's hardcoded session path with a fixture that parses the real `--session-dir` argument and otherwise performs Pi0.80.7's default cwd encoding. Use real `mkdirSync`, then write the existing native Pi fixture with actual launch cwd.

```ts
const encoded = '--' + resolve(process.cwd()).replace(/^[/\\]/, '').replace(/[/\\:]/g, '-') + '--';
const sessionDir = suppliedSessionDir ?? join(process.env.HOME!, '.pi/agent/sessions', encoded);
mkdirSync(sessionDir, { recursive: true });
```

- [ ] Create several short path components until the real launch cwd would encode beyond255bytes, including a space in private-home ancestry. Assert the no-explicit-directory control produces real `ENAMETOOLONG`, and the generated-launcher conversation regression fails before the correction.
- [ ] Add the existing shell-quoted private home substitution to Pi's invocation before `"$@"`:

```bash
--session-dir $QUORUM_AGENT_HOME_SH/.pi/agent/sessions \
```

- [ ] Verify selected path equals the private capture root, outer HOME receives nothing, matching flat/nested JSONL is captured and wrong-cwd evidence is excluded. Preserve wrong-cwd-only refusal, completion/cancellation retention and tmux cleanup tests. Replace stale omission assertions rather than extending command-string tests.
- [ ] Update active comments/HOWTO describing default cwd nesting; keep history and `**/*.jsonl` unchanged. Assert only pricing/review admit Pi using parsed scenario directives.
- [ ] Run affected Pi, conversation, normalizer/capture, launcher-isolation/substitution and scenario-pinning tests with `bun run test`, typecheck/lint/scenario validation. Commit; explicitly leave exact installed Pi0.80.7 and live qualification to root.

### Task 3: Preserve assessor tool errors and freeze one instruction candidate

**Files:** G `src/models/provider.ts`, `src/models/anthropic.ts`, `src/assessment/assess.ts`; tests `test/models/anthropic.test.ts`, `test/assessment/assess.test.ts`, existing OpenAI codec test. Keep protocol correction and prompt candidate in distinct commits for independent selection.

**Interfaces:** Add optional `isError?: boolean` to `ToolResultBase`; preserve `LLMClient` signatures. The existing assessment loop's error decision supplies both evidence logging and the queued tool result. Anthropic uses `is_error:true`; OpenAI retains its existing call-id/text contract and has no equivalent result flag.

- [ ] Read the retained SDK boundary diagnosis and existing clients/validators. Add a local actual-SDK regression whose first structured response calls `report_result` without required reasoning and whose second response is valid. Capture outgoing request JSON; assert the rejection is a failed tool result, rejected data is never accepted, valid correction is accepted, and usage/history remain intact. Observe the missing flag failure before source edits.
- [ ] Add the typed marker, propagate the existing assessment error decision to results, and serialize marked errors in both Anthropic text/image result branches. Successful results omit the flag. Do not infer errors from arbitrary content inside the provider codec.

```ts
// Queued result uses the same decision as the existing logger.
results.push(error ? { ...result, isError: true } : result);
// In each Anthropic tool_result object:
...(result.isError === true ? { is_error: true } : {}),
```

- [ ] Test marked text/image failures, unmarked success, exact tool-use IDs and preserved error text through OpenAI's codec. Test scoped-read/unavailable-tool failures as well as malformed reports. Do not add QA-loop changes unrelated to this assessment failure.
- [ ] Run focused model/assessment tests and typecheck; commit protocol correction separately. Record that absent error flags cannot explain the first malformed generation and that improved model repair remains a live hypothesis.
- [ ] Without reading constructed control contents/expectations, write one concise general assessor prompt correction: every original criterion clause needs evidence; inspect actual delivery and contradictory transcript/output; distinguish observed behavior from asserted consequences; do not treat missing evidence as confirmed absence; distinguish exact local test claims from independent checks and preserve chronology. Require a real structured `report_result` with all required top-level fields and no XML/text substitute. Keep existing tools, schemas and validation unchanged.
- [ ] Use the previously audited failures as the semantic red baseline, not prompt literal assertions. Run existing assessment tests/typecheck for machinery, commit the candidate separately and report its frozen SHA before control exposure. Do not modify this candidate after paid results; root owns its semantic gate.

### Task 4: Clarify simulated-user conditional answers and neutrality

**Files:** G `src/conversation/converse.ts`; Q `scenarios/conversation-design/story.md`. Existing `test/conversation/converse.test.ts` and Q `test/conversation-input.test.ts` cover the unchanged transport/projection.

**Interfaces:** Preserve `ConverseOptions`, terminal tools, `ConversationRecord` and `projectConversationStory`. Keep private acceptance criteria identical. Commit G prompt and Q brief changes separately in assigned worktrees.

- [ ] Read the complete user briefs, offending exchanges and driver diagnosis. The feedback agent proposed wall time before the driver demanded it; preserve that attribution distinction. The design answer condition is underspecified and needs clarification.
- [ ] Clarify the general system prompt: opening request versus conditional private facts; disclose only facts relevant to the actual question; maintain neutral approval when the brief delegates engineering judgment; obey explicit brief constraints even if the subject proposes a shortcut. Keep natural exchanges, terminal startup/completion rules and user authority from the brief.
- [ ] Clarify only design's answer-if-asked prose so local/browser, channel and watch-selection preferences are supplied when those dimensions are asked about. Do not script exact replies, reveal private rubric text or modify criteria.
- [ ] Run existing conversation/projection tests and typechecks; verify original/new projected rubric bytes identical and new conditional prose stays in the brief. No prompt wording tests. Commit and report that live adherence remains unproven until root's targeted cases.

### Task 5: Freeze retained-case verification and adapt the existing finite operator

**Files:** Q `docs/experiments/2026-09-08-conversation-reliability/` for inputs/expectations/protocol and a dated operator copy; focused operator test only for changed execution contracts. Original corpus/operator/evidence stay unchanged.

**Interfaces:** Reuse base cases `{id,rubric,evidence_root,evidence_index}`, separate criterion expectations, existing scoped Gauntlet assessment, shared spend lease and ordinary result/usage artifacts. No new product CLI/API or generalized experiment layer.

- [ ] Freeze six known cases: the four original retained known cases plus latest Claude debugging and Codex review-feedback. Use their original selected rubrics and complete indexes; preserve the clarified review rubric already on main. Reuse six existing constructed controls unchanged and explicitly labeled constructed. Independent curator/reviewer agrees all expectations before calls; preserve driver-contamination caveat and supported local-test receipts in reasoning expectations.
- [ ] Keep expectations outside every evidence index. Pin/hashes cover sources, rubrics, evidence and order. Known stage has12candidate rows, controls stage12candidate rows; exactly two repetitions per case. Historical baseline errors are observations, not a fresh matched comparison or population error rate.
- [ ] Adapt the previously reviewed dated operator from experiment commit `b9f77eba` into the new dated directory. Limit changes to owned candidate source/path, candidate-only12/12case cardinality, $8 allocation and new finite cutoff and existing shared 90-minute retained window. Preserve strict source/input/output validation, private credential projection, shared lease, child cancellation, available usage pricing and explicit stopped/completed summaries. The new exact cutoff must fit the spec's four-hour live window and is frozen before calls.
- [ ] Run the existing finite-operator behavior tests adjusted for candidate-only12/12 rows: duplicate/reused inputs, hash/source mismatch, incomplete prior stage, cumulative budget/window, cancellation and malformed output remain refused/stopped. Do not turn the operator into a reusable production feature. Commit and independently review before launch.

### Task 6: Installed proof, bounded live gates and delivery

**Owner:** Root. **Artifacts:** this plan ledger, dated experiment results, private `results/conversation-reliability/` receipts, existing pilot helper/campaigns.

- [ ] Integrate reviewed independent task commits, run required Q/G checks and actual paired CLI tests once on final selected runtime. Preserve old candidates. Run final combined code review; handle any findings in one correction wave and scoped rereview.
- [ ] Recheck canonical/pilot doctor, refs, image, installed Pi package and idle ownership through Tailscale. Prepare isolated pilot sources without changing canonical refs underneath live work.
- [ ] Exercise the generated Pi launcher in the exact installed image at a deep cwd with external networking disabled and no real credentials. Use a startup path that creates a session manager, not `--help`, `--list-models`, `--no-session` or resume. Obtain actual selected session path; no-prompt startup alone does not prove JSONL persistence. Preserve baseline failure and corrected proof separately.
- [ ] Freeze/start the new24-call retained protocol with one candidate. Audit known outcomes/reasoning before controls; stop the affected experiment on any invalid output or semantic failure. No prompt tuning or replacements. Select baseline assessor for independent Pi/driver work if the candidate fails.
- [ ] Freeze eight maximum fresh cells: Pi pricing then Pi code-review qualifications; one design and two review-feedback conversations per harness on Claude/Codex consume the remaining six slots. No replacement Pi cell if qualification stops. Keep original credentials/Superpowers/image and no Pi effort. Audit actual user adherence, delivery and grader reasoning separately; record judgments before official exposure.
- [ ] Use helper status/costs/report and authenticated show targets. Verify native/output/check/usage publication, expected missingness for errors, exact owned termination and lease release. Present behavioral failures as results; a driver violation is separately attributed.
- [ ] Merge only eligible pieces directly to main, verify final-main CI, update canonical via helper after idle verification and record installed refs/doctor. Commit positive/negative outcomes. Move PRI-3102 to In Review with an honest reflection; preserve artifacts/worktrees and report any unpromoted scope.
