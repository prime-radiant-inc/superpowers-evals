# Conversation Evals Release Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox syntax for tracking.

**Goal:** Ship a normal conversation author-to-report workflow and verified Pi support, testing one bounded assessor correction alongside it.

**Architecture:** Keep Quorum's existing worker, scheduler, credential and publication boundaries. Independent changes live in isolated worktrees and receive separate reviews before integration. The root coordinator alone owns remote operations, provider launches, cancellation and final promotion.

**Tech Stack:** TypeScript, Bun, existing shell fixtures, Gauntlet terminal transport and scoped evidence assessment.

**Spec:** `docs/superpowers/specs/2026-09-07-assessment-reliability-overnight-design.md`.

## Global Constraints

- Conversation plus fresh assessment is the intended single superpowers-evals workflow. New `quorum new` output uses it by default; no mode flag. Existing QA scenarios are migrated before their execution path is retired in subsequent work.
- Baseline Q `debc8011ec442f249766bfbeb01aace01f12e2cb`; baseline G `6dac4bfcb16042cb277067bb4535f9f22b9bb5df`; Superpowers `b36e0829c6d0140e93cfef2ca599b1b07d4a7797`.
- Preserve report schemas, canonical JSON/Markdown, folding, publication, sealing, original grades and retained evidence. No additional reader generation or backward-compatibility layer.
- One assessor prompt candidate; fixed Sonnet 5 Mantle route and common frozen rubrics. Drew authorized the sole pre-call review criterion 3 clarification in the spec; preserve original rubrics/results and use separately derived identical replay rubrics for both versions. Maximum 40 assessor calls, two minutes per call, 90-minute assessment window.
- Maximum two Pi qualification attempts plus fourteen fresh acceptance attempts. Ten-minute conversations, 900-second attempt bounds, global cap four for acceptance.
- Provider allocation: $12 retained assessment, $6 Pi qualification, $22 acceptance, $40 total. Stop on missing/unpriced required usage; these are observed-cost stopping allocations, not hard billing caps.
- Cutoff `2026-09-08T14:00:00Z` (07:00 Pacific). Cancellation and required cleanup may continue afterward. No manual lock removal, retries or replacement cells.
- No provider calls, SSH, pushes or merges by implementation workers. Root performs those authorized actions after applicable gates. No worker-spawned subagents; root supplies review.
- Use real behavior tests. No prompt wording assertions, giant generated-string regex tests, or claims that scripted clients establish semantic accuracy.
- Each independently verified piece may ship even if another stream fails. Report actual merged/installed state after a post-merge failure.

---

### Task 1: Default conversation authoring and usable recipe

**Files:** Q `src/scaffold.ts`, `test/scaffold.test.ts`, `test/conversation-input.test.ts`, `README.md`, `docs/scenario-authoring.md`.

**Interfaces:** Preserve `newScenario(scenarioDir: string, name?: string): string`. Consume `projectConversationStory(story)` and existing manifest generation. No new CLI flag or scaffold option.

- [ ] Add a red behavioral test that creates a real scaffold, projects its story, and verifies the private-criteria split and runtime mode. Use existing test fixtures and cleanup. The essential contract is:

```ts
const dir = newScenario(join(root, 'fresh-conversation'));
const story = readFileSync(join(dir, 'story.md'), 'utf8');
const projected = projectConversationStory(story);
expect(projected.brief.trim().length).toBeGreaterThan(0);
expect(projected.brief).not.toContain('## Acceptance Criteria');
expect(projected.rubric).toContain('## Acceptance Criteria');
```

- [ ] Run `bun test test/scaffold.test.ts test/conversation-input.test.ts`; observe the new contract fail before editing the template.
- [ ] Make the template emit `quorum_mode: conversation` and `quorum_max_time: 10m`, a natural user brief, answer-if-asked guidance and delivery/refusal stopping rule, with private evidence-based criteria. Retain the current setup helper, checks structure, permissions and manifest workflow. Do not change how existing metadata-less stories execute.
- [ ] Write one copyable author→check→arm/suite→appliance register/run/status/costs/report→show recipe. Use existing committed conversation arms/suites and credential selection. Document Linux Claude/Codex as established coverage; Pi's measured scope is updated only after root reports qualification. Explain two evaluation roles and completion versus grade.
- [ ] Re-run affected tests and `bun run typecheck`; exercise scaffold plus generated manifest with actual CLI commands in temporary paths. Self-review and commit only these files.

### Task 2: Human campaign readout using existing evidence

**Files:** Q `src/appliance/cli.ts`, new `src/appliance/campaign-render.ts`, `src/cli/index.ts`, `src/cli/costs.ts` terminology, `test/appliance-cli.test.ts`, new `test/appliance-campaign-render.test.ts`.

**Interfaces:** Export a pure terminal formatter consuming the existing typed report envelope (`report` and `anchor`). Select it only after the existing campaign report action succeeds and only without `--json`. Use the actual exported Report type; do not create a second report schema.

- [ ] Add a behavioral CLI test with the existing injected `campaignReport` action: non-JSON report renders scenario/arm, accepted outcome and relevant criterion/check detail; `--json` decodes to exactly the unchanged action payload. Assert small public facts, not an entire text snapshot.
- [ ] Add structured formatter tests for pass, failed criterion/checks, indeterminate later-stage failure, missing publication, partial prices, and ambiguous verdict references. A pass/usable outcome must never be presented as proof of conversation completion.
- [ ] Implement compact terminal tables/details from existing `attempt.evidence.gauntlet`, `checks`, `missingness`, prices and coverage. Correct combined-grader wording. Print a shell-safe exact `quorum show` target only from one authenticated root-level `<run>/verdict.json` artifact and `anchor.roots.results`; state that it runs where those results exist. Missing/ambiguous targets remain unavailable.
- [ ] Keep `src/campaign/report-publication.ts`, report schemas and canonical renderer unchanged. Prove an existing report can be reread without altering JSON/Markdown/seal bytes using existing publication fixtures; do not add any new publication behavior.
- [ ] Run affected CLI/formatter/publication tests and typecheck. Self-review, commit, and report public output examples without raw sensitive evidence.

### Task 3: Explicit Linux Pi conversation support

**Files:** Q `src/runner/index.ts`, `src/runner/conversation.ts`, `scenarios/conversation-pricing/checks.sh`, `scenarios/conversation-code-review/checks.sh`, `test/runner-conversation.test.ts`, `test/normalize.pi.test.ts`, `test/agent-pi.test.ts`, relevant capture tests.

**Interfaces:** Extend the explicit supported conversation normalizer union from `'claude' | 'codex'` to include `'pi'`; reuse Pi's existing provisioned interactive launcher and capture configuration. Do not bulk-enable all normalizers. Preserve the unsupported OS/family guard.

- [ ] Add red tests proving a real Pi-shaped native session at the correct cwd is retained through the conversation path, the wrong cwd is rejected, and unsupported families remain refused before costly setup. Reuse `test/fixtures/pi-session.slice.jsonl` and real normalizer/provisioning seams.
- [ ] Add/extend lifecycle tests covering terminal completion and cancellation with retained evidence and confirmed cleanup. Existing loopback/fake-dependency tests are appropriate; no provider calls.
- [ ] Admit Pi at the two runner preflight/type boundaries and let its existing capture path run. Opt only pricing/review into Pi via the scenario eligibility comments. Preserve check semantics/manifests and credential/effort validation.
- [ ] Run `bun test test/runner-conversation.test.ts test/normalize.pi.test.ts test/agent-pi.test.ts` plus affected capture tests, typecheck and `bun run quorum check`. Inspect actual launcher inputs; do not simulate unsupported effort for Pi.
- [ ] Commit the offline implementation and report that live Pi qualification remains root-owned. Do not claim support is proven by these checks alone.

### Task 4: One general assessor instruction candidate

**Files:** G `src/assessment/assess.ts`; existing `test/assessment/assess.test.ts` only if a real contract test needs correction.

**Interfaces:** Preserve `runAssessment(AssessOptions): Promise<VetResult>`, its tools, report schema and role boundary. Candidate implementer must not read Task 5 control contents or results before freezing the candidate commit.

- [ ] Read the current prompt, validators and the known-case findings in the spec. Run existing assessment tests as baseline.
- [ ] Implement only the five instruction requirements in the spec's One candidate change section: original obligation coverage, delivered-work grounding, contrary evidence, accurate absence versus unavailable evidence, and scoped independent-check receipts. Use task-independent language, not UNION/watch-specific keywords.
- [ ] Run `bun test test/assessment/assess.test.ts` and typecheck. Do not write prompt literal tests or pretend scripted outcomes validate semantic judgment.
- [ ] Self-review and commit this one candidate. Record exact SHA for replay. Do not revise it after seeing paid assessment results.

### Task 5: Independently curated assessment controls

**Files:** Q `docs/experiments/2026-09-08-conversation-release/controls/`, `cases.json`, `expected.json`, `README.md` in that dated directory. Work in a separate checkout from Task 4.

**Interfaces:** Use the existing base-case shape `{ id, rubric, evidence_root, evidence_index }`. Expectations live in a separate file with case id, per-criterion expected verdict, decisive evidence paths and rationale. The root expands baseline/candidate and repetition rows for the operator. Never put expectations or prior assessor output in an evidence index.

- [ ] Declare the four known full-bundle cases from the breadth experiment: Claude review fail, Codex design fail, supported Codex review and supported Claude design. Preserve original full evidence indexes and rubrics. Verify expected criterion-level judgments from the prior audit, not solely the published pass.
- [ ] Apply the independently reviewed criterion 3 clarification to the scenario and derive separate retained-review replay rubrics changing only that criterion. Preserve both original auditor judgments, document original/derived hashes and exact differences, and obtain independent agreement on clarified expectations before replay. Keep the candidate prompt frozen and the call/allocation limits unchanged.
- [ ] Construct six controls as three positive/negative pairs specified by the approved spec. Use complete constructed dialogue/delivery and ordinary source/output files. For whole-bundle checks, execute the real offline oracle and retain its actual receipt; do not fabricate a native session or execution log.
- [ ] Keep controls out of the prompt implementer's view. Independently review expectations and decisive evidence before any provider call. A disagreement blocks the disputed control rather than being resolved against an observed grade.
- [ ] Validate every index using Gauntlet's existing `validateEvidenceIndex`, confirm expected/rubric/private files are not accidentally indexed, and run the offline checks. Hash the corpus; commit with explicit constructed-evidence labeling. Return only corpus paths and count to root until the candidate is frozen.

### Task 6: Finite assessor operator adaptation

**Files:** Q new `docs/experiments/2026-09-08-conversation-release/run.ts` and focused local behavioral tests; preserve `docs/experiments/2026-09-07-review-calibration/run.ts` unchanged.

**Interfaces:** Retain the prior operator's `--execute <inputdir> <outputdir>` invocation. A frozen execution input contains existing case row fields plus exact `gauntlet_root` and `gauntlet_sha` per row. Known input has 16 explicit unique rows; control input has 24. Record Q SHA, pricing and frozen input hashes. Support a declared prior known-stage summary for cumulative budget/deadline accounting on the second stage; root authorizes the second invocation only after independent known-stage review.

- [ ] Read the entire prior operator before adapting. Retain its existing credential projection, shared spend lease, private HOME/TMPDIR, two-minute external child deadline, usage pricing and signal cleanup. Source roots remain two owned pinned checkouts, not arbitrary commands.
- [ ] Derive output scenario/run IDs from each parsed rubric so design/pricing controls work. Reject duplicate rows/output reuse, unknown source roots/SHAs, dirty tracked sources and unexpected case counts. Keep exact source identity and input/output separation checks.
- [ ] Enforce a shared $12 allocation and 90-minute assessment window across both invocations, as well as absolute `2026-09-08T14:00:00Z` cutoff. The second stage must verify the first stage's complete graded/priced row set and deduct its cost; missing prior usage or inconsistent identities refuses before a model call. Root's semantic review remains a separate explicit launch decision, not a new product admission system.
- [ ] Record an explicit completed versus stopped summary, every case's process status/grade/path/cost and stop reason. A valid fail is a graded result. Never interpret exit zero as complete; missing/unpriced usage, timeout, lost lease and cancellation stop further calls.
- [ ] Exercise case planning/accounting/deadline/termination with fake subprocess/provider boundaries or extracted local functions. Include mixed rubric IDs, second-stage cumulative spend, duplicate/reused output rejection and cancellation. No live calls/SSH. Typecheck/build-import the script, self-review and commit.

### Task 7: Integrate, review and run bounded qualification

**Owner:** Root coordinator. **Artifacts:** plan ledger, dated experiment record, ignored `results/conversation-release/` receipts and remote pilot output.

- [ ] Independently review each implementation's full diff and tests, resolve required findings, and cherry-pick clean commits into the release checkout. Keep Task 4 candidate G separate from baseline. Run required Q/G checks once on each final changed runtime, plus the actual paired Q/G CLI integration tests.
- [ ] Live-recheck canonical/pilot doctor, clean source refs/config, available fixed image, required Pi/extensions and idle ownership through Tailscale. Preserve original artifacts and unrelated state. Correct routine owned setup within scope; stop the affected stream if a different architecture is required.
- [ ] Freeze corpus/order/pricing/source SHAs and run known 16 assessor calls. Independently review all candidate criteria and decisive reasoning. Only if that gate passes, run the frozen 24 controls and review them. No new candidate or hidden retries. Select baseline G if the candidate fails or demonstrates no benefit.
- [ ] Separately register/run two sequential Pi qualification attempts via the pilot helper using baseline G and `pi_gpt56_sol`, without an effort field. Verify native/visible/output/check/cost publication and cleanup. Do not spend concurrently with retained assessment; the shared spend lease has one owner.
- [ ] Register the predeclared 14-cell acceptance matrix if Pi qualifies, otherwise the 12-cell Claude/Codex subset. Keep budgets/stage limits and root ownership. Run through the helper, poll status/costs, produce standard reports and reconcile all owned workers before concluding.
- [ ] Give independent auditors rubric/evidence first; record their judgments before exposing official grades. Assess prompt, Pi and terminal readout against their separate gates. Run any post-review code corrections through covering tests and scoped review before promotion.

### Task 8: Deliver verified pieces and close the night

**Owner:** Root coordinator. **Artifacts:** committed dated experiment results, final main/source/deployment receipts, PRI-3102 and heartbeat state.

- [ ] Run a broad final review over the combined code changes, with separate Q/G packages and the ledger's outstanding findings. Integrate only eligible reviewed pieces, preserving failed candidates. Record any partial delivery precisely.
- [ ] Fetch current remote refs; fast-forward or otherwise normally integrate approved changes directly to main without PRs or force pushes. Preserve unrelated work. Run canonical helper prepare with the pinned Superpowers ref after owned live workers stop; verify selected G/Q SHAs, image and doctor.
- [ ] Observe final CI, collect ordinary reports, known costs and missingness, final termination/lock state, and the exact author/run/report recipe. Commit experiment outcomes with negative evidence equally visible. Move PRI-3102 to In Review with implementation reflection.
- [ ] Pause the task heartbeat and release only the owned sleep inhibitor at completion or cutoff. Leave the user a self-contained morning result and the remaining coverage/migration work. Do not delete retained evidence or this plan's live experiment records.
