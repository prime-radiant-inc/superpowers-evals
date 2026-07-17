# PR #1998 Independent Eval Campaign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Execute the replicate-and-extend eval campaign specified in `docs/superpowers/specs/2026-07-16-pr1998-eval-campaign-design.md` against superpowers PR #1998, producing per-block verdicts, an experiment log, and a PR reply. Ticket: PRI-2650.

**Architecture:** Two waves of appliance batches (paired dev/PR arms) plus locally-authored scenario work merged to evals `main` between waves. Deterministic checks + Gauntlet judge verdicts compose per-run; pre-registered transcript protocols cover what checks can't measure.

**Tech Stack:** quorum (Bun ≥1.3), the `evals-appliance` helper (see `docs/appliance-runbook.md`), setup-helpers fixtures (TypeScript), bash check-verb DSL.

**Execution order (local-first — supersedes the spec's author-during-wave-1 parallelism):**
`1 → 2 → 4 → 5 → 9 → 10 → 11 → 12 → 13 → 14 → 3 → 6 → 7 → 15 → 8 → 16 → 17`.
All local work (config, audit, hardening, precheck, scenario authoring) merges to evals `main` in ONE reviewed PR (Task 14) before the box syncs (Task 3). All measured runs then share one campaign window: Tasks 6, 7, and 15's submission groups run back-to-back; Task 8's triage/classification covers all of them (run it after Task 15's batches complete, folding Task 15 Step 3 into it). Consequence: block-1 claude cells run the route-extended `sdd-fix-loop-resumes-implementer` — Task 10's claude-semantics guard is therefore load-bearing: diff the claude-visible ACs and checks before/after the extension and confirm they are identical.

## Global Constraints

- **Spec is law:** `docs/superpowers/specs/2026-07-16-pr1998-eval-campaign-design.md`. Any deviation gets logged in the experiment log's Deviations section.
- **Every measured run is on the appliance.** Local slim-container runs are iteration only and never count.
- **Arms:** control = superpowers `dev` pinned SHA (Task 2 records it); treatment = PR head `1f97eda`. Contemporaneously paired: the two arms' back-to-back lock-serialized jobs = one window.
- **Credentials:** claude = appliance default (`opus_bedrock`); codex = ALWAYS `--credentials openai_responses`. Grader is harness-pinned `claude-sonnet-5`.
- **Never read `sdd-quality-reviewer-catches-planted-defect` or `sdd-spec-context-consumed` at n=1.**
- **Judge-stall / `investigate` verdicts are not observations** — re-run, log the stall.
- **Ledger literals** (from SKILL.md at `1f97eda`, copy exactly, em-dash included): `Task <N>: fix round <R>/5 (<X> addressed, <Y> open — <finding one-liners>; commits <a7>..<b7>)`, `Task <N>: parked — <finding> — ruling: <why the code stands>`, `Task <N>: complete (commits <base7>..<head7>, <K> parked)`.
- Scenario `checks.sh` files: `pre()`/`post()` only, no executable bit, bare verbs from `src/checks/prelude.sh` only (verb list = `Object.keys(FS_VERBS)` + the 13 trace verbs in `src/check/verbs.ts`). Do not invent verbs — check the vocabulary before writing a check.
- Commit after every task; `bun run check` and `bun run quorum check` must pass before any commit touching `src/` or `scenarios/`.
- A reference copy of the PR's SKILL.md is at the session scratchpad `skill-1f97eda.md`; re-fetch with `curl -sL https://raw.githubusercontent.com/obra/superpowers/1f97eda0fc73faac6cdc870bfeadfdaa3b431a00/skills/subagent-driven-development/SKILL.md` if absent.

---

### Task 1: Raise the opus_bedrock concurrency cap

**Files:**
- Modify: `credentials.yaml` (opus_bedrock entry, ~lines 15–27)

**Interfaces:**
- Produces: `opus_bedrock.max_concurrency: 6` on evals `main`, which Task 3 syncs to the box.

- [ ] **Step 1: Edit the entry.** Change `max_concurrency: 2` to `max_concurrency: 6` under `opus_bedrock:`. Replace the comment line `# 2 until the Bedrock account RPM/TPM quota is probed.` context with: `# max_concurrency 6: quota probed 2026-07-16 (20M in / 4M out TPM, no RPM row; PRI-2650).` Keep the rest of the comment block intact.
- [ ] **Step 2: Validate.** Run: `bun run check && bun run quorum check`. Expected: both exit 0.
- [ ] **Step 3: Commit and push.**
```bash
git add credentials.yaml
git commit -m "feat(credentials): opus_bedrock max_concurrency 2->6 — quota probed (PRI-2650)"
git push origin main
```

### Task 2: Pre-register the campaign — experiment log skeleton with pinned SHAs

**Files:**
- Create: `docs/experiments/2026-07-17-pr1998-fix-loop-validation.md`

**Interfaces:**
- Produces: the pinned control SHA (`DEV_PIN`) every later task uses; the pre-registered protocols Tasks 8/15 execute verbatim.

- [ ] **Step 1: Resolve the control pin.** Run: `git ls-remote https://github.com/obra/superpowers.git refs/heads/dev` — record the SHA as DEV_PIN. Confirm treatment: `gh pr view 1998 --repo obra/superpowers --json headRefOid` must still be `1f97eda0fc73faac6cdc870bfeadfdaa3b431a00`; if not, STOP and surface to Drew (spec contingency).
- [ ] **Step 2: Write the skeleton.** Sections, in order: Hypotheses (copy the spec's four claims verbatim); Config (DEV_PIN, `1f97eda`, credentials, grader pin, appliance); Pre-registered protocols (copy the spec's **Measurement protocols** section verbatim — block-2 mechanism taxonomy + criterion, blocks 4–6 resume sweep, codex precheck, triage-triggered pairing); empty Verdicts tables per block (0–7); Negative results; Deviations (first entry: log filename is 07-17, spec said 07-16 — campaign started a day after spec); Economics.
- [ ] **Step 3: Commit and push.**
```bash
git add docs/experiments/2026-07-17-pr1998-fix-loop-validation.md
git commit -m "docs(experiments): PR #1998 campaign pre-registration — pins + protocols (PRI-2650)"
git push origin main
```

### Task 3: Appliance preflight

**Files:** none (operational; results recorded in the Task 2 log's Config/Deviations)

**Interfaces:**
- Consumes: Task 1's pushed cap raise.
- Produces: a prepared box with both refs, verified grader credit, and the discovered run-all scenario-targeting flag (`TARGET_FLAG`) Tasks 6/7/15 use.

- [ ] **Step 1: Sync + doctor.** Per `docs/appliance-runbook.md` and the `primeradiant-ops:quorum-appliance-remote-run` skill: sync the box's evals checkout (`sudo /srv/quorum/bin/sync-repos.sh` as ec2-user), then `evals-appliance doctor --json`. Expected: healthy; confirm the synced evals HEAD includes Task 1's commit.
- [ ] **Step 2: Prepare both arms.** `evals-appliance prepare --json --superpowers-ref <DEV_PIN>` and `evals-appliance prepare --json --superpowers-ref 1f97eda0fc73faac6cdc870bfeadfdaa3b431a00`. Expected: both succeed.
- [ ] **Step 3: Grader credit sanity.** Drew topped the key up 2026-07-17. Verify on the box: a 1-token direct-Anthropic API call with the bundle's `ANTHROPIC_API_KEY` returns 200 (not a `credit balance is too low` error). Record the check in the log.
- [ ] **Step 4: obol pricing.** In the evals repo: `grep '"obol"' package.json` — version must be ≥0.8.0 (prices opus-4.8, sonnet-5, gpt-5.6 family). Record.
- [ ] **Step 5: Discover the scenario-targeting flag.** Run `bun run quorum run-all --help` (locally) and read `src/run-all/` if needed. The 2026-07-15 #1943 panel targeted 9 SDD scenarios, so a mechanism exists (flag, tag, or tier). Record the exact syntax as TARGET_FLAG in the log. Do not guess it later.
- [ ] **Step 6: Commit the log updates.** `git add docs/experiments/2026-07-17-pr1998-fix-loop-validation.md && git commit -m "docs(experiments): PR #1998 preflight results (PRI-2650)" && git push origin main`.

### Task 4: Block 0 — hostile audit of the author's three scenarios

**Files:**
- Read/possibly modify: `scenarios/sdd-breaker-structural-blocks/{story.md,setup.sh,checks.sh}`, `scenarios/sdd-breaker-adjudicates-at-cap/...`, `scenarios/sdd-fix-loop-resumes-implementer/...`, their fixtures in `src/setup-helpers/sdd-fixtures.ts` (`scaffoldSddMidloopStructural`, `scaffoldSddMidloopParked`, `scaffoldSddResumeTriggerPlan`)

**Interfaces:**
- Produces: audited (possibly patched) checks that blocks 1–3 runs are measured against; findings recorded in the log's Block 0 table.

- [ ] **Step 1: Audit each `checks.sh` with this checklist** (record every finding, even "clean"):
  1. **Non-ASCII literal traps:** `grep -nP '[^\x00-\x7F]' scenarios/sdd-*/checks.sh` — the `parked —` em-dash literal in `sdd-breaker-adjudicates-at-cap` is a known hit. Decide per instance: does SKILL.md at `1f97eda` *mandate* that exact character (it does for ledger lines — see Global Constraints), or could a compliant agent write ASCII? Only mandated literals stay.
  2. **False-pass holes:** for each `file-contains`, ask "can this string appear in a NON-compliant run?" (e.g. a ledger line quoted inside a *plan* file the fixture seeds, or produced by the seeded fixture itself rather than the agent). Check what each fixture pre-seeds: `grep -n 'parked\|ruling\|fix round' src/setup-helpers/sdd-fixtures.ts` and confirm no post-check literal is already satisfied at setup time. Any check whose literal the fixture itself seeds is a false-pass hole — fix by asserting on content the agent must add.
  3. **Negation coverage:** every "must not happen" AC in story.md has a corresponding `not ...` check or is explicitly judge-owned.
- [ ] **Step 2: Fix what the audit catches** (smallest semantic-preserving edits), run `bun run quorum check` + `bun test test/setup-helpers-sdd.test.ts`. Expected: pass.
- [ ] **Step 3: Commit.** `git add -u scenarios src test && git commit -m "fix(scenarios): block-0 audit fixes for sdd fix-loop trio (PRI-2650)" && git push origin main` (skip commit if audit found nothing; log "clean" instead).

### Task 5: Close the planted-defect false-pass residual

**Files:**
- Modify: `scenarios/sdd-quality-reviewer-catches-planted-defect/checks.sh`

**Interfaces:**
- Produces: a hardened check block 4 measures against.

- [ ] **Step 1: Read the current check.** Locate the `grep -A8 "empty lastLogin"` (widened from `-A4` in commit 4174685) inside `post()`. The documented residual: an unmandated test landing immediately after a never-fixed planted test can false-pass the window.
- [ ] **Step 2: Bound the grep to the planted test block.** Replace the fixed `-A8` window with an extraction bounded by the test-function delimiter, e.g. `awk '/empty lastLogin/,/^\}/'` (adjust the end pattern to the fixture's actual test syntax — read the fixture first) piped to the same assertion. The assertion semantics must not change for a compliant run.
- [ ] **Step 3: Validate against history.** Re-run the check logic (as a plain shell snippet) against the workdir of the author's known-good run `...T171734Z-bceb` and known-false-fail run `...T165649Z-d69b` if those run dirs are present under `results/`; expected: good passes, and construct a synthetic false-pass file (unmandated test after planted test) that the OLD check passes and the NEW check fails.
- [ ] **Step 4: Commit.** `bun run quorum check && git add -u && git commit -m "fix(scenarios): bound planted-defect grep to test block — close false-pass residual (PRI-2650)" && git push origin main`.

### Task 6: Wave 1, rounds 1–3 — paired replication batches (blocks 1+2)

**Files:** none (operational; verdicts land in the log)

**Interfaces:**
- Consumes: TARGET_FLAG (Task 3), DEV_PIN (Task 2).
- Produces: block-1 verdicts (n=3 per arm) and 3 of the 7 dev-arm coin-flip observations; run/batch ids recorded in the log.

Scenario set S1 = `sdd-breaker-structural-blocks`, `sdd-breaker-adjudicates-at-cap`, `sdd-fix-loop-resumes-implementer`.

- [ ] **Step 1: Submit round R (repeat this step for R = 1, 2, 3).** Two back-to-back jobs = one window; record both `job_id`s:
```bash
# treatment arm
evals-appliance run-all --json --detach \
  --superpowers-ref 1f97eda0fc73faac6cdc870bfeadfdaa3b431a00 \
  -- <TARGET_FLAG selecting S1> --coding-agents claude,codex --credentials openai_responses --jobs 4
# control arm (submit when treatment job completes; the lock forbids overlap)
evals-appliance run-all --json --detach \
  --superpowers-ref <DEV_PIN> \
  -- <TARGET_FLAG selecting S1> --coding-agents claude,codex --credentials openai_responses --jobs 4
```
  Note: under the local-first execution order, Task 10's route extension has already merged, so `sdd-fix-loop-resumes-implementer` is UNPINNED by the time this task runs. Do NOT let codex run it here — submit S1 for claude, and S1 minus `sdd-fix-loop-resumes-implementer` for codex (two targeted submissions per arm). Codex-on-fix-loop cells belong exclusively to block 3 (Task 15 Step 1, 3 treatment / 2 control).
- [ ] **Step 2: Between rounds, grader-credit check** (Task 3 Step 3 method). If drained: STOP submissions, surface to Drew, mark affected cells void in the log (they are re-run, not counted).
- [ ] **Step 3: Coin-flip extension — 4 more dev-arm claude runs** of the fix-loop scenario:
```bash
evals-appliance run --json --detach \
  --superpowers-ref <DEV_PIN> \
  --scenario scenarios/sdd-fix-loop-resumes-implementer \
  --coding-agent claude   # x4, sequential
```
- [ ] **Step 4: Collect.** For each job: `evals-appliance show --json <job-id>`; record every run id + verdict in the log's block-1/2 tables. Do not interpret yet (Task 8). Commit the log.

### Task 7: Wave 1, singleton round — blocks 4+5+6

**Files:** none (operational)

**Interfaces:**
- Produces: block 4–6 verdicts + the treatment transcripts Task 8's resume sweep reads.

Scenario sets: S4 = `sdd-quality-reviewer-catches-planted-defect` (claude ×3, codex ×1), `sdd-rejects-extra-features`, `sdd-escalates-broken-plan`, `sdd-spec-constraint-preserved` (each claude ×1 + codex ×1, PR arm only); S5a = `sdd-same-plan-resume`, `sdd-stale-foreign-workspace` (draft — single-scenario jobs, both arms × both agents, n=1); S5b = `sdd-spec-context-consumed` (claude, both arms, n=3); S5c = `user-pref-sdd-no-strategy-prompt` (codex, both arms, n=1); S5d = `mid-conversation-skill-invocation` (claude, PR arm, n=1); S6 = `sdd-go-fractals-opus48` (claude), `sdd-go-fractals-gpt55` (codex), PR arm n=1, individual jobs.

- [ ] **Step 1: Submit the run-all-able PR-arm set** (S4 + S5d at n=1; repeat the claude planted-defect and spec-context cells to reach n=3 — if TARGET_FLAG cannot express per-scenario counts, top up with single-scenario `run` jobs).
- [ ] **Step 2: Submit S5b control arm** (spec-context claude ×3 on DEV_PIN) back-to-back with its treatment reps — this cell is paired by design, not triage-gated.
- [ ] **Step 3: Submit the draft pair S5a** as single-scenario jobs (drafts are excluded from run-all): 2 scenarios × 2 arms × 2 agents = 8 `evals-appliance run` jobs (codex with `--credentials openai_responses` if the single-run path supports it — if it does not (memory: only run-all forwards quorum args), route those cells through run-all with TARGET_FLAG + `--include-drafts` if that flag exists; verify, do not guess; record which path was used).
- [ ] **Step 4: Submit S5c + S6.** S6 jobs are individual; after each completes, check for orphaned processes on the box (`ps` sweep of the run's workdir tree) per the wedge mitigation.
- [ ] **Step 5: Collect all verdicts into the log tables; commit.** Grader-credit check between each batch.

### Task 8: Wave-1 triage, mechanism classification, resume sweep

**Files:**
- Modify: `docs/experiments/2026-07-17-pr1998-fix-loop-validation.md`

**Interfaces:**
- Consumes: all wave-1 run ids; the pre-registered protocols (Task 2).
- Produces: block 1/2/4/5/6 adjudicated verdicts; the contingency re-run list.

- [ ] **Step 1: Triage every non-pass** per `docs/superpowers/skills/triaging-a-failing-eval.md`: attribute to {skill defect | scenario debt | harness debt | judge noise} with transcript evidence (`bun run quorum show <target>`, then the run's `trajectory.json`). `investigate` verdicts → re-run (does not count), log the stall.
- [ ] **Step 2: Block-2 mechanism classification (pre-registered).** For each of the 7 dev-arm fix-loop runs: read `trajectory.json` (the `flattenToolCalls` view via `src/atif/project.ts` shapes what to look for) and classify {resumed implementer | fresh/dedicated fix dispatch | pre-flight defused | other} with a one-line evidence quote each. Apply the criterion verbatim: supported iff ≥2 mechanisms observed ≥2× among fix-cycle entrants; <4 entrants → underpowered, not adjudicated.
- [ ] **Step 3: Resume sweep.** Same classification over every treatment-arm wave-1 transcript that contains a fix cycle; count organic rounds-1–3 resumes. Zero → record "evidence gap" per spec.
- [ ] **Step 4: Contingency pairs.** For any block-4/5/6 PR-arm fail that triage attributes to a possible skill defect: submit a fresh contemporaneous pair (treatment + control, same window, n=2 each). Known-noisy scenarios: rep before attributing.
- [ ] **Step 5: Write block verdicts vs the spec's decision rule into the log; commit and push.**

### Task 9: Codex capability precheck (local, cheap)

**Files:**
- Modify: `docs/experiments/2026-07-17-pr1998-fix-loop-validation.md` (Precheck section)

**Interfaces:**
- Produces: EXPECTED_ROUTE ∈ {native-resume, fallback} that Task 10's route list and block-3 reads depend on.

- [ ] **Step 1: Document trail.** Read `coding-agents/codex-context/HOWTO.md`, `src/setup-helpers/codex-app-server.ts`, and codex's own docs for the collab/agent tool surface: does a live spawned agent accept a follow-up message (any send/resume primitive besides `spawn_agent`/`wait_agent`/`close_agent`)?
- [ ] **Step 2: Empirical probe.** Minimal local codex session (host `codex` CLI, cheapest model): spawn a trivial subagent, attempt a follow-up message to it. Record the exact tool names offered and the outcome. No appliance time.
- [ ] **Step 3: Record EXPECTED_ROUTE + evidence in the log; commit.**

### Task 10: Route-extend `sdd-fix-loop-resumes-implementer` for codex

**Files:**
- Modify: `scenarios/sdd-fix-loop-resumes-implementer/{story.md,checks.sh}`, `test/scenario-pinning.test.ts`
- Branch: create `pri-2650-sdd-probe-scenarios` off `main` — Tasks 10–13 all commit here.

**Interfaces:**
- Consumes: EXPECTED_ROUTE (Task 9).
- Produces: an unpinned scenario whose ACs sanction codex's sanctioned routes; claude semantics untouched (block-1 replication depends on this).

- [ ] **Step 1: Extend the story ACs.** In story.md's sanctioned-route list, add the codex-conditional route, e.g.: "On harnesses without live-subagent messaging, the specified fallback — a fresh dispatch carrying the task brief, the implementer's report file, and the findings — is a sanctioned route; a fresh *findings-only* fix dispatch remains a hard fail." If EXPECTED_ROUTE is native-resume, also sanction codex-native resume phrased mechanism-neutrally ("re-engaging the original implementer agent"). Do not alter any claude-route sentence.
- [ ] **Step 2: Update checks.** Remove `# coding-agents: claude` from checks.sh. Verify every deterministic check is harness-neutral (they gate outcomes — trailing newline shipped, tests pass — not mechanisms; confirm by reading).
- [ ] **Step 3: Update the pinning test.** In `test/scenario-pinning.test.ts`, remove `'sdd-fix-loop-resumes-implementer'` from the pinned list (its comment says "Extend the route list before unpinning" — Step 1 did).
- [ ] **Step 4: Validate + commit.** `bun run check && bun run quorum check`; commit: `feat(scenarios): route-extend sdd-fix-loop-resumes-implementer for codex (PRI-2650)`.

### Task 11: Probe (a) — `sdd-round4-escalates-model`

**Files:**
- Create: `scenarios/sdd-round4-escalates-model/{story.md,setup.sh,checks.sh}`
- Modify: `src/setup-helpers/sdd-fixtures.ts` (new `scaffoldSddMidloopRound3`), `src/setup-helpers/registry.ts` (`scaffold_sdd_midloop_round3` entry)
- Test: `test/setup-helpers-sdd.test.ts`

**Interfaces:**
- Consumes: `HelperContext` (`src/setup-helpers/context.ts`); the metrics-plan fixture family in `scaffoldSddMidloopParked` (`sdd-fixtures.ts:1046`) as the derivation base.
- Produces: scenario dir consumed by Task 14's iteration and Task 15's wave-2 batch.

- [ ] **Step 1: Write the failing fixture test** (mirror the existing `scaffoldSddMidloopParked` test's shape in `test/setup-helpers-sdd.test.ts`):
```ts
test("scaffold_sdd_midloop_round3 seeds a round-3/5 ledger with a cheap-tier implementer recorded", async () => {
  const dir = await runHelperInTempDir("scaffold_sdd_midloop_round3");
  const ledger = await readFile(join(dir, ".superpowers/sdd/progress.md"), "utf8");
  expect(ledger).toContain("fix round 3/5");
  expect(ledger).not.toContain("fix round 4");
  expect(ledger).toMatch(/implementer model: .*haiku/i);
  expect(ledger).toContain("1 open");
});
```
  (Use the file's actual temp-dir/read helpers — read the existing tests first and match them exactly.)
- [ ] **Step 2: Run it, expect FAIL** (`bun test test/setup-helpers-sdd.test.ts`) with unknown-helper error.
- [ ] **Step 3: Implement the scaffold.** Derive from `scaffoldSddMidloopParked`: same metrics repo/plan; ledger ends with Task 2 mid-loop — three completed fix-round lines in the mandated format, last line `Task 2: fix round 3/5 (1 addressed, 1 open — repeated formatting expression in formatDuration; commits <seeded>..<seeded>)`, plus a brief note line `Task 2 implementer model: claude-haiku-4-5 (cheapest tier)` and the corresponding open-finding detail in the task-2 report file the fixture seeds. Register as `scaffold_sdd_midloop_round3: { fn: scaffoldSddMidloopRound3 }`.
- [ ] **Step 4: Test passes; write the scenario.** `setup.sh` = the 3-line pattern (`#!/usr/bin/env bash`, `set -euo pipefail`, `setup-helpers run scaffold_sdd_midloop_round3`). `story.md`: resume framing identical in structure to `sdd-breaker-adjudicates-at-cap`'s (spec-aware, names the skill, points at the plan and ledger, "pick up where we left off"); ACs (evidence-demanding): (1) the agent runs fix round 4 as a **fresh implementer dispatch, explicitly on a model at least one tier above the recorded stuck implementer** — transcript must show the dispatch naming the model; (2) no round runs past 5; (3) round 4 (or 5) is followed by a findings-scoped re-review; (4) hard fail if round 4 re-uses the stuck implementer or an equal/cheaper tier. `checks.sh` `post()` (deterministic floor; tier verification is judge-owned):
```bash
post() {
    check-transcript skill-called superpowers:subagent-driven-development
    check-transcript tool-called Agent
    file-contains '.superpowers/sdd/progress.md' 'fix round 4/5'
    not file-contains '.superpowers/sdd/progress.md' 'fix round 6'
    command-succeeds 'npm test'
}
```
  `pre()`: mirror the adjudicates-at-cap `pre()` but assert `fix round 3/5` present and `fix round 4` absent.
- [ ] **Step 5: Validate + commit.** `bun run check && bun run quorum check`; commit: `feat(scenarios): sdd-round4-escalates-model probe + fixture (PRI-2650)`.

### Task 12: Probe (b) — `sdd-re-review-scoped`

**Files:**
- Create: `scenarios/sdd-re-review-scoped/{story.md,setup.sh,checks.sh}`
- Modify: `src/setup-helpers/sdd-fixtures.ts` (`scaffoldSddMidloopRound1`), `src/setup-helpers/registry.ts`
- Test: `test/setup-helpers-sdd.test.ts`

**Interfaces:**
- Consumes: same fixture family as Task 11.
- Produces: scenario dir for Tasks 14/15.

- [ ] **Step 1: Failing test** (same harness as Task 11's Step 1): ledger last line `fix round 1/5`, `2 open` findings, no round 2, findings enumerated in the seeded task-2 report file.
- [ ] **Step 2: Implement** `scaffoldSddMidloopRound1` (derive again from `scaffoldSddMidloopParked`; last ledger line `Task 2: fix round 1/5 (1 addressed, 2 open — missing input guard in formatDuration; repeated formatting expression; commits <seeded>..<seeded>)`). Register `scaffold_sdd_midloop_round1`. Test passes.
- [ ] **Step 3: Scenario.** story.md: same resume framing; the behavior under test is the **next round's re-review scope**. ACs: (1) the agent resumes at round 2 (fix dispatch for the two open findings); (2) the post-fix re-review dispatch is **scoped to the two named findings** (re-review-prompt shape) — the transcript must show the re-review prompt enumerating exactly those findings, and a fresh full review of the whole diff is a hard fail; (3) round-2 ledger line appended in the mandated format; (4) task completes or parks per the loop rules. Before writing checks, read `src/check/verbs.ts` for a trace verb that can assert on a dispatched prompt's content; if one exists, add a deterministic check that the re-review dispatch mentions a seeded finding string; if not, the scope AC stays judge-owned and `post()` gates the floor:
```bash
post() {
    check-transcript skill-called superpowers:subagent-driven-development
    check-transcript tool-called Agent
    file-contains '.superpowers/sdd/progress.md' 'fix round 2/5'
    command-succeeds 'npm test'
}
```
- [ ] **Step 4: Validate + commit** (message: `feat(scenarios): sdd-re-review-scoped probe + fixture (PRI-2650)`).

### Task 13: Probe (c) — `sdd-final-review-single-wave`

**Files:**
- Create: `scenarios/sdd-final-review-single-wave/{story.md,setup.sh,checks.sh}`
- Modify: `src/setup-helpers/sdd-fixtures.ts` (`scaffoldSddTasksDoneFinalPending`), `src/setup-helpers/registry.ts`
- Test: `test/setup-helpers-sdd.test.ts`

**Interfaces:**
- Consumes: fixture family; SKILL.md §final-review at `1f97eda` (scratchpad copy) — extract the exact final-review ledger vocabulary from it before writing any literal.
- Produces: scenario dir for Tasks 14/15.

- [ ] **Step 1: Failing test:** ledger has `Task 1: complete`, `Task 2: complete` (one with `1 parked)` and a `Task 2: parked —` + `ruling:` pair), `Task 3: complete`, and **no** final-review completion marker; all three tasks' code present and `npm test` green in the seeded repo.
- [ ] **Step 2: Implement** `scaffoldSddTasksDoneFinalPending` (extend the metrics fixture to all-tasks-complete; seed 2–3 realistic review-findable warts in the completed code — e.g. duplicated literal, missing input guard — so the final review has genuine findings). Register. Test passes.
- [ ] **Step 3: Scenario.** story.md resume framing: "all tasks are complete; the final whole-branch review hasn't run — pick up where we left off and finish." ACs: (1) the agent runs the final whole-branch review, **informing it of the parked/deferred ledger lines**; (2) all findings from that review are fixed in **ONE fix dispatch** (a single wave), followed by **exactly one scoped re-review**; (3) any residual finding after that re-review is adjudicated breaker-style (parked with a written `ruling:` or surfaced as BLOCKED) — dispatching a second fix wave is a hard fail; (4) the branch ends in the skill's specified done state. `post()` floor: `check-transcript skill-called ...`, `check-transcript tool-called Agent`, `command-succeeds 'npm test'`, plus the final-review ledger literal extracted in this task's Interfaces note (do not invent it — copy from SKILL.md).
- [ ] **Step 4: Validate + commit** (message: `feat(scenarios): sdd-final-review-single-wave probe + fixture (PRI-2650)`).

### Task 14: Local iteration + scenario PR + box sync

**Files:** the Task 10–13 branch; PR to evals `main`.

**Interfaces:**
- Produces: probes on evals `main` and synced to the box — wave 2's hard precondition.

- [ ] **Step 1: Iterate each probe locally** in the claude-slim container (`container/Dockerfile.claude-slim`; mount per `scripts/evals-container` with explicit `--superpowers-root` pointing at a *clean clone* of the PR branch — never the live checkout; that was the #1943-class contamination incident). One local run per probe on claude; fix fixture/check bugs until the run is *interpretable* (not necessarily passing — a legitimate skill-defused seed is a finding, not a bug; apply the 5a–5d lesson before reshaping ACs). Local runs are not measured.
- [ ] **Step 2: PR the branch to evals `main`**, using the normal repo flow (`gh pr create`), title `PR #1998 campaign: codex route extension + 3 SDD probes (PRI-2650)`. Get it reviewed/merged (Drew or self-merge per repo norms — ask Drew if unclear).
- [ ] **Step 3: Sync the box** (`sync-repos.sh`) and confirm the synced HEAD contains the merge.

### Task 15: Wave 2 — blocks 3 + 7

**Files:** none (operational)

**Interfaces:**
- Consumes: merged probes, EXPECTED_ROUTE, TARGET_FLAG, DEV_PIN.
- Produces: block 3/7 verdicts + transcripts; classification per protocol.

- [ ] **Step 1: Block 3.** Codex on the route-extended scenario: treatment ×3, control ×2, paired windows (single-scenario jobs or TARGET_FLAG batches — reuse whichever path Task 7 Step 3 validated for codex-with-credentials). Read each transcript for the route actually taken; compare to EXPECTED_ROUTE.
- [ ] **Step 2: Block 7.** All three probes: claude treatment ×2 + control ×2, paired windows throughout; grader-credit check between batches. The control (DEV_PIN) arm is the RED half of each probe's improvement claim — a dev run that *passes* a probe means the probe doesn't discriminate; triage it as scenario debt, not as evidence against the PR.
- [ ] **Step 3: Triage + classify** (same protocol as Task 8, including the 5a–5d "defeated probe = documented negative result" rule); write block verdicts; commit the log.

### Task 16: Finalize the experiment log

**Files:**
- Modify: `docs/experiments/2026-07-17-pr1998-fix-loop-validation.md`

- [ ] **Step 1: Per-block verdicts** against the spec's decision rule, with the merge-supporting / not-merge-supporting call made explicitly and every non-pass attributed. Negative results (defeated probes, judge stalls, voided cells) at equal billing.
- [ ] **Step 2: Economics.** Sum `economics.total_est_cost_usd` from each run's `verdict.json` (batch `costs` is known-broken — use per-run verdicts via each batch's `results.jsonl` run ids). Report per-block and total.
- [ ] **Step 3: Commit + push.**

### Task 17: Report out — PR reply, memory, ticket

**Files:** none (external systems)

- [ ] **Step 1: PR #1998 reply.** Comment answering the maintainer's ask: campaign design pointer (spec + PRI-2650), per-claim verdicts, notable findings, negative results, economics — with the experiment-log link as the canonical record. Draft it for Drew's review before posting (outward-facing).
- [ ] **Step 2: Memory updates.** Update `MEMORY.md`-indexed files: campaign pointer + any new signature facts (e.g. codex resume capability, coin-flip base rate) in the existing sdd/codex/claude memory files — update, don't duplicate.
- [ ] **Step 3: Ticket.** Move PRI-2650 to In Review with the reflective implementation comment (linear-ticket-lifecycle skill format: what went smoothly / what was tricky / how it felt / risk flags).
