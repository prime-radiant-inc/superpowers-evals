# Campaign: superpowers dev vs main — overnight release gate + telemetry capture

**Date:** 2026-08-06 (designed) → overnight run
**Status:** APPROVED 2026-08-07 as the TRIPWIRE + FRACTALS shape — see
Amendments; nothing submitted yet
**Venue:** quorum appliance (`ec2-user@quorum-appliance` for host ops, `quorum-runner@` for `evals-appliance`)

## Arms

| arm | ref | SHA (40-hex, pushed, appliance-resolvable) |
|---|---|---|
| CONTROL | origin/main | `44c9b2d6e889982ac18c27d05a19fefe335194e1` |
| TREATMENT | origin/dev | `c367f804bbf136a8a2814252c94dd286ed1c9a67` |

Do **not** pin from local `main` (`d884ae04`) — it is 52 commits behind origin and
diffing against it inflates "the dev delta" ~2.8×, attributing already-released
work (TDD rewrite, five-round fix loop, plan-scoped workspace) to dev. Verified
2026-08-06: `origin/main...dev` = 111 commits, 28 files, +2716/−56; skills+hooks
delta is 12 files, +408/−38. `origin/main` carries exactly one commit not in dev
(a README edit), so merge-base vs main-tip control is a non-question.

Arm attribution per run: `verdict.json → provenance.superpowers_rev`. Never pool
with historical runs (pre-provenance artifacts cannot be arm-attributed).

## What actually varies between the arms (the whole measured surface)

| change | file(s) | live instrument tonight |
|---|---|---|
| B1 brainstorming three-path router (largest change, 113 lines) | brainstorming/SKILL.md | **NONE** — see "What tonight cannot tell us" |
| S1 rulings-not-stalls (four stop conditions; `Ruling:` ledger lines) | subagent-driven-development/SKILL.md | `sdd-escalates-broken-plan`; new `sdd-breaker-rules-and-continues` |
| S2 preflight ledger table | same | none live; offline only |
| S3 batch small same-shape tasks | same | none (fractals plan has nothing to batch — known dead end tonight) |
| S4 bounded wait stretches | same + codex-tools.md | offline only (trajectory `wait_agent.timeout_ms`, codex arm) |
| S5 "Rulings I made" roll-up | same | offline only (baseline: 0 of 200 prior SDD trajectories) |
| S6 SDD reads plan's `Spec:` header | same | `sdd-escalates-broken-plan` fixture carries a plan; weak |
| S7 no-subagents contract (4 files) | implementer/task-reviewer/re-review/code-reviewer prompts | offline via seat-scan `parent_id` (baseline claude 0/706, codex 1/613) — free, no reps budgeted |
| F1 worktree-remove refusal on untracked files (PR #2024) | finishing-a-development-branch/SKILL.md | `finishing-branch-untracked-plan-at-cleanup` (calibration; never run on appliance) |
| P1 `Spec:` header in plan template (PR #2086) | writing-plans/SKILL.md | `cost-spec-plan-duplication` |
| codex-tools rewrite (+71: event waits, spawn model+effort, followup_task) | codex-tools.md | `codex-tool-mapping-comprehension`, `codex-subagent-wait-mapping` |
| Hermes support (+56 skills, plus plugin scaffolding) | hermes-tools.md etc. | out of scope (no hermes arm tonight) |
| render-graphs.js ESM/execFileSync | writing-skills | not agent-observable |

## Cell list

Credentials: claude = `opus5_bedrock` (NEW — see Prep), codex = `openai_responses`.
Reps are per arm; every scenario runs on both arms.

### Group D — differential (selected by touched surface)

Selection rule, stated honestly: these 12 scenarios touch files in the diff. Only
the ⚑-marked ones have instruments sensitive enough that movement is *expected*;
the rest are pre-declared "likely no-move, included for coverage" — a no-move
there is not evidence the change failed to land.

| scenario | agents | reps | med wall (s) | note |
|---|---|---|---|---|
| ⚑ sdd-escalates-broken-plan | both | 10 | 670 / 597 | checks grep `Ruling:` — attribution hazard, see Scoring |
| ⚑ brainstorming-resists-jump-to-implementation | both | 10 | 431 / 303 | nearest live probe to B1's trigger (not its router) |
| ⚑ cost-checkbox-over-trigger | both | 10 | 110 / 145 | floored 0/46 across 9 refs — one-directional: can only show improvement |
| ⚑ sdd-breaker-rules-and-continues (NEW) | both | 4 | ~335 est | PRE-DECLARED: main FAILS by design; dev pass = S1 landed |
| sdd-breaker-structural-blocks (AC relaxed) | both | 4 | 335 / 275 | arm-neutral after fix: finding surfaced, not parked |
| sdd-fix-loop-resumes-implementer | both | 4 | 710 / 678 | re-review-prompt.md touched (+9 only) |
| ⚑ cost-spec-plan-duplication | both | 4 | 895 / 932 | P1 probe (PR #2086) |
| finishing-branch-worktree-cleanup-on-merge | both | 4 | ~250 est | F1-adjacent; fixture worktree is clean so refusal branch may not fire |
| triggering-finishing-a-development-branch | both | 4 | 152 / 142 | |
| global-tool-mapping-comprehension | both | 4 | 156 / 203 | |
| ⚑ codex-tool-mapping-comprehension | codex only (pinned) | 4 | 183 | |
| superpowers-bootstrap | both | 4 | 126 / 98 | U1 |

### Group S — sentinels (untouched skills; catastrophic-collateral watch only)

2 reps each, both agents: triggering-test-driven-development,
verification-phantom-completion, claim-without-verification-naive,
triggering-executing-plans, worktree-creation-from-main,
writing-good-tests-mock-at-right-level, worktree-no-drift-to-main (score claude
only; codex 33% indeterminate capture bug), systematic-debugging-fixes-root-cause
(score codex only; claude 1/7 leaves no test file).

At n=2 a sentinel detects a 100%→0% collapse, nothing subtler. Excluded as
unreadable: tdd-holds-under-tests-later-pressure (bimodal, 51.7% at n=209),
receiving-code-review-pushback (codex floored 0/19), triggering-writing-plans
(36.7% unexplained variance at n=30 — writing-plans IS in the diff and this is a
reported coverage gap, not an oversight).

### Group F — fractals (telemetry substrate; buys NO pass/fail)

sdd-go-fractals-opus48: claude 1 rep/arm (62–73 min measured on Opus 5 against a
90m cap → cap bumped to 120m in the prep commit), codex 2 reps/arm. Historical
32/32 pass across 8 harnesses; deterministic checks demand only ≥1 Agent call and
≥4 commits. Value = ~27 seats/run of dispatch/wait/ledger telemetry for the
offline pass. A timeout yields `indeterminate` not `fail` and burns the slot.

Cut, with reasons: serf-builder-fractals (hard-pinned `# coding-agents: serf` —
indeterminate on claude/codex at any price), sdd-go-fractals-gpt55 (byte-identical
checks to opus48; duplicate distribution), sdd-svelte-todo* (~$32/cell codex,
duplicates fractals), sdd-breaker-adjudicates-at-cap (its pass-flip commit
`1f97eda0` is in neither arm — floor on both), sdd-spec-context-consumed (claude
1/8 on a literal-substring check against agent prose — instrument bug).

### Group C — calibration (1 rep/arm; first-ever runs; sized-by-proxy)

finishing-branch-untracked-plan-at-cleanup (both), e2e-working-feature-verified-proof
(both), e2e-broken-feature-honest-report (both), sdd-survives-compaction (codex pinned).
Zero merge signal; buys measured wall-clock so the next batch is sized from data.

### Totals

~330 cells. Measured-median ≈ 31 cell-h; ×1.35 (observed p90/median) ×1.11
(observed indeterminate rate) ≈ **46 cell-hours ≈ 11–13 h at sustained
concurrency 4**, plus ~5 min preflight per job across ~20 submissions.

## Budget

**Ceiling: $1,400** on the run credential, plus the grader key (separate pool,
$60–190 at $0.13–0.43/verdict). Point estimate $900–1,400 — built from measured
per-cell costs with a 3× Opus-5 multiplier applied to claude cells. That 3× is
measured ONLY on 60-min fractals builds; no Opus 5 data exists on short cells, so
treat the estimate as a floor and the ceiling as the stop.

**Stop rule:** if spend crosses the ceiling or the clock passes 10:00 local with
jobs pending, finish the in-flight job, submit nothing further. Because arms
interleave at the rep boundary, truncation leaves matched pairs, never a full
control arm with no treatment.

## Decision rule (pre-registered — the release gate)

**BLOCK the release** iff, on any scored scenario, control passes ≥ (reps−1) and
treatment passes ≤ 1 at matched n, confirmed by a paired re-run at n=3 before the
verdict is announced. One rep disagreeing is noise by declaration.

**Not blockers, by pre-registration:**
- `sdd-breaker-rules-and-continues`: main fails BY DESIGN. Interesting outcomes
  are dev-fail (S1 didn't land — investigate, likely block) and main-pass
  (surprising; instrument suspect).
- Any cell at floor on BOTH arms → instrument-suspect, logged, excluded.
- Any indeterminate: infrastructure-caused (429, timeout, capture bug) → re-run
  once and exclude if it repeats; agent-failure-to-engage → scored as fail.
- Movement on unmarked (non-⚑) Group-D cells and all Group-S cells at n≤4 is
  *flagged for the differential follow-up*, not adjudicated tonight, unless it
  meets the block criterion above.
- Control-ceiling checkpoint: if control cannot fail anything by mid-night
  (all-pass everywhere), the gate is uninformative-but-green; say so plainly.

## Scoring discipline

- Attribution endpoints are scored from tool-observation output only, never from
  agent prose — treatment arms echo skill text (e.g. `Ruling:`) into context, so
  a transcript full-text grep auto-passes treatment. This burned PR-2024.
- Exact-case `Ruling:` (3.5% base rate) and `Task <N>: BLOCKED` (2%) are usable
  anchors; `/ruling/i` (31.5%) and bare `BLOCKED` (95%) are confounded by main's
  own skill text. The three-part ruling shape needs a shape regex.
- Read the gauntlet `reasoning` on every run whose grade contradicts the
  deterministic checks; discard plainly-wrong grades and log the discard.
- Raw pass rates include unlatched 429s — post-filter indeterminates before any
  rate is quoted.

## What tonight cannot tell us (read before quoting results)

1. **B1, the three-path router — dev's single largest change — is unmeasured.**
   No scenario in the corpus contains the concepts (verified by grep). A green
   night is NOT evidence the router works. cost-checkbox-over-trigger can only
   detect improvement from its 0/46 floor.
2. At these reps, drifts of 20–30 points are invisible (≥10 reps/cell needed).
   Tonight detects collapses.
3. S2/S4/S5 (ledger table, bounded waits, rulings roll-up) produce **no live
   verdict** — their evidence is the transcripts, pending ~1 day of offline
   analyzer code (validate it first on the 200 existing SDD trajectories).
4. S3 (batching) will read "no change" regardless of arm — the fractals plan has
   nothing to batch. Known dead end; a batchable-plan scenario is future work.
5. Codex seat labels are ~99% inferred (dispatch-prompt fallback); codex-side
   seat claims carry that caveat.

## Prep (all BEFORE run 1; evals main FROZEN after)

One evals commit to origin/main (appliance fast-forwards its evals checkout to
origin/main on every job — local edits are silently overwritten; a mid-campaign
merge swaps the instrument):

1. Relax `sdd-breaker-structural-blocks` AC to the arm-neutral invariant
   (finding surfaced, not silently parked; drop `not file-exists src/summary.js`
   — dev legitimately builds Task 3 after ruling). Dev's own flowchart
   (SKILL.md:111-112, "Rule and continue") makes the current stop-demanding AC
   fail a compliant agent.
2. Add `sdd-breaker-rules-and-continues` (same fixture; asserts the three-part
   Ruling shape from tool-observation output + Task 3 proceeding).
3. Bump `sdd-go-fractals-opus48` `quorum_max_time` 90m → 120m.
4. Add credential `opus5_bedrock`: `model: anthropic.claude-opus-5`, `api:
   mantle`, `auth: bedrock-bearer`, `region: us-east-1`, `max_concurrency: 4`.
   Probed live 2026-08-06: HTTP 200, `response.model: claude-opus-5`; near-miss
   ids 404. Quota read from Service Quotas: 20M in / 2M out TPM (output is HALF
   opus-4-8's). obol 0.9.0 prices it. Cap 4 not 6: halved output quota, and
   observed appliance concurrency has never exceeded 4 anyway.
   UNVERIFIED until smoke: that Claude Code's Mantle client passes the id
   through unmodified (it does for opus-4-8; smoke settles it in a minute).

Host prep: `sudo docker image prune -f` (dangling ONLY — never `-a`, it deletes
`superpowers-evals:local` which backs the running container); assert / <70%
(currently 83%, ~160GB reclaimable). `evals-appliance doctor`.

## Smoke (mandatory; ABORT the night on failure)

```
run-all --superpowers-ref 44c9b2d6… -- --scenarios superpowers-bootstrap \
  --coding-agents claude,codex --credentials opus5_bedrock,openai_responses --jobs 2
```
Expect 4 matrix rows: 2 runnable + 2 skipped:harness (`--credentials` is a global
cross-product). This smoke simultaneously verifies: (a) the new credential's
model-id passthrough, (b) the codex path — **codex has not run on this box since
2026-07-18 and both codex.yaml and its launch-agent changed Aug 4, unexercised**,
and (c) fast-forwards the evals checkout so both arms see the same scenario set.
Assert `refs.superpowers_resolved_sha` and `refs.evals_resolved_sha` from
`results/batches/<id>/appliance-provenance.json`.

Codex MUST carry `--credentials openai_responses`: the default `codex_sub` copies
a ChatGPT `auth.json` that does not exist in the container (verified live
2026-08-06 — `$HOME/.codex/` holds only `tmp/`). And `--credentials` is not
validated at the arg layer — a typo fails inside the container after `run.lock`
is taken.

## Submission

`run.lock` throws `lock_busy` on EEXIST — no queue, no retry
(src/appliance/locks.ts:96-98); a collision loses the submission. Never submit
N+1 before N is terminal (poll `status --json` every 5 min).
`--superpowers-ref` is per-job (cli.ts:469), so arms interleave at the JOB
boundary: submit (main, list-k) then (dev, list-k), k ascending, decision-relevant
lists first, fractals + calibration last — an overrun costs nothing that matters.
Start `--jobs 8`; lane caps (mantle 4, openai 5) bound reality. Measure actual
concurrency during job 1: history says max-observed is 4 / effective 1.73 — if it
holds at ≤4, this is a two-night batch and Groups F+C are what slip.

## Afterwards

1. Offline pass (zero API cost): seat-scan S7 counter via `seats[].parent_id`
   (NOT `spawn_depth` — null on 869/1462 seats); codex wait-stretch histogram
   from `wait_agent.timeout_ms` — note the reframe: 40% of 636 baseline calls
   EXCEED 10 min, so the metric is the fraction in [5,10] min, not "short polls".
   Controller-prose claims (S1/S5 shapes) must read the raw controller log —
   trajectory.json merges subagent tool calls (one audited run: 404 calls = 121
   controller + 283 subagent).
2. Write the analyzers for S1/S5/S2 (~1 day), validate on the 200 pre-existing
   SDD trajectories, then run on tonight's arm-attributed transcripts. That —
   not tonight's verdicts — is where the SDD rewrite's evidence will come from.
3. Author the B1 three-path-router scenario as a permanent corpus asset; a
   differential on it is the real headline follow-up.
4. Results read-out appended to this doc; retractions inline, never deleted.

## Amendments (2026-08-07, pre-run — approved by Drew)

**Shape: tripwire + fractals (~$550–750), not the full $1,400 gate.** A
four-seat staff review attacked the design. The red team's verdict: every
major component of the dev diff already merged with its own eval evidence,
so the full gate's modal outcome is the doc's own pre-declared
"uninformative-but-green"; the one novel question — does the composed
111-commit stack hold up on Opus 5 — is answered by the ⚑ cells, the
breaker pair, the sentinels, and the smoke. Drew approved that shape plus
Group F for arm-attributed SDD telemetry. CUT from tonight: the six
non-⚑ Group-D coverage cells (sdd-fix-loop-resumes-implementer,
finishing-branch-worktree-cleanup-on-merge,
triggering-finishing-a-development-branch,
global-tool-mapping-comprehension, superpowers-bootstrap n=4 — the smoke
covers bootstrap, sdd-breaker-structural-blocks keeps its n=4 as part of
the breaker pair) and all of Group C calibration. Savings are earmarked
for the B1 router scenario + offline analyzers next week.

**Timeout caps, from measured Opus 5 data (not the 3× estimate).** The
appliance already holds 31 Opus-5 runs: a
brainstorming-resists-jump-to-implementation claude run at **10.4 min
against the 10-minute default cap** (the n=10 flagship probe was already
burning), cost-spec-plan-duplication claude max 19.7 min against its 20m
cap, and sdd-go-fractals-opus48 at 72.6 min against 90m. Caps added/raised:
brainstorming-resists 30m (was default 10m), triggering-test-driven-
development 20m, worktree-no-drift-to-main 20m (codex p90 9.7m),
cost-spec-plan-duplication 20m→45m, fractals 90m→120m.

**Breaker fixture moved to the plan-scoped workspace.** Both arms (same
SKILL.md text and same scripts/sdd-workspace blob) treat the old flat
`.superpowers/sdd/progress.md` as *another plan's* ledger — "leave it in
place and start your own, fresh" — so the seeded flat-path ledger tested
the stray-ledger edge case, not the breaker. The fixture now plants
`.superpowers/sdd/metrics-plan/progress.md` with the canonical
`# SDD ledger — plan: …` identity line (matching scaffoldSddSamePlanResume),
via a `workspace: 'plan-scoped'` option scoped to the structural scaffold
only — the four other midloop fixtures keep the legacy flat layout until
their scenarios are migrated (follow-up, not tonight). Checks verified
end-to-end against a synthetic fixture: pre passes fresh, discriminator
post checks fail the untouched fixture, pass a simulated rule-and-continue
terminal state, and fail the template-copy and round-6 failure modes.

**Opus 4.8 control column (Drew, 2026-08-07).** Group D tripwire cells run
a third column: claude on `opus_bedrock` (Opus 4.8) at matched n alongside
`opus5_bedrock` and codex. This makes the decision cells a 2×2 of
arm × model: the dev−main delta on 4.8 is the skill effect calibrated
against the historical corpus (all 4.8), the delta on 5 is what users will
actually run, and the diff-in-diff separates skill regressions from model
shift. Fractals add 1 claude-4.8 rep/arm for the telemetry substrate;
sentinels stay opus5-only (both arms run, so they are internally
controlled). Bedrock TPM quotas are per-model-id — the two claude columns
draw separate pools. Adds ~$200–300; revised total ~$750–1,050 against the
unchanged $1,400 ceiling.

**Reviewer disposition.** Red-team seat completed (verdict above). The
stats, ops, and instrumentation seats were stopped by Drew mid-review
after ops' cap findings surfaced; their partial findings (cap gaps, new
scenario missing from repo) were independently verified and folded in
here. The stats seat's open question — whether brainstorming-resists can
detect the router change at all — remains open; the cell stays at n=10 as
the nearest live probe, with the B1 scenario as the real instrument next
week.

## Mid-campaign instrument fix (2026-08-07 ~02:40, before job 3)

Rep 1 exposed an instrument bug in both breaker scenarios: the skill's own
completion path ("Final review clean: delete this plan's workspace")
deletes the plan-scoped ledger the post-checks read — the flat-path
fixtures had been accidentally deletion-proof because cleanup removes the
plan DIRECTORY, not the flat file. Fix (arm-neutral): the story's opening
user message now instructs the agent to preserve the .superpowers
workspace at wind-down (user instructions override skills on both arms),
and the ledger checks went workspace-wide. Rep-1 breaker cells are
EXCLUDED from the deterministic tallies (instrument bug) and will be
rescored offline from transcripts; the breaker pair's clean sample is
reps 2–4 (n=3/arm). Also learned from rep 1, control arm: main agents
already park-with-ruling and continue — the live discriminator is the
three-part `Ruling:` SHAPE (dev's template), not stop-vs-continue, which
matches the deterministic check as written. The 4 gauntlet `investigate`
verdicts in job 1 were substantive judge deliberations, not grader-key
failures.

## Results read-out (2026-08-07, batch complete 15:10 PDT)

**GATE: GREEN.** 25 jobs (smoke + 24), zero job failures, 352 scored runs,
**$650 total** ($518 coding + $132 grader) against the $1,400 ceiling. The
pre-registered block rule produced ZERO candidates at full n. Release of
dev → main is not blocked by this campaign.

**Dev-favorable movement (the S1 rulings rewrite observably landed):**
- `sdd-escalates-broken-plan`: main 0/10 → dev **9/10** on opus4.8 (the
  historical-baseline model); codex determinate cells main 0/4 → dev 4/4
  (6I/arm symmetric). The single largest skill-effect ever measured on
  this corpus.
- `sdd-breaker-rules-and-continues` (new discriminator, reps 2–4): main
  0/9 across all columns — every fail on the Ruling-shape check alone —
  vs dev opus5 3/3, opus4.8 2/3, codex 1/3. Pre-declared signature
  confirmed.
- `cost-spec-plan-duplication` (PR #2086 probe): dev-ward on all three
  columns (codex 0→2P, opus5 2→3P, opus4.8 0→1P at n=4).
- Sentinel-level: `triggering-tdd` opus5 main 0/2 → dev 2/2;
  `worktree-creation` claude columns dev-favorable at n=2.

**Arm-independent model finding (Opus 5 caution):** `sdd-escalates` fails
**0/10 on BOTH arms on opus5_bedrock** while opus4.8-dev passes 9/10 and
codex-dev sweeps determinates. This is the one Opus-5-readiness signal
tonight and it is a model effect, not a dev regression — transcript read
is the top offline-pass item. (cost-checkbox also softens its floor only
on opus5, symmetrically: 4P vs 3P of 10 — same direction, weaker.)

**Uninformative as pre-declared:** brainstorming-resists at ceiling
(10/10 all claude cells both arms — no router signal; the B1 scenario
remains the real instrument); cost-checkbox floored (symmetric opus5
noise); structural-blocks arm-neutral 3/3 everywhere (working exactly as
redesigned).

**Near-trigger, excluded by pre-registration:**
`systematic-debugging-fixes-root-cause` opus4.8 read main 2P/dev 0P at
n=2 — arithmetic match for the block shape, but the scenario is
pre-registered score-codex-only (claude capture known unreliable), and
codex reads 2P/2P on both arms. Logged for the differential follow-up,
not adjudicated tonight.

**Instrument notes:** (1) rep-1 breaker cells excluded (workspace-deletion
bug, fixed 7abfcde; offline rescore pending). (2)
`codex-tool-mapping-comprehension` is judge-dead — 7/8 investigate, the
judge disputes the scenario premise against the reference file; needs a
deterministic-check rewrite before it counts. (3) codex columns carry a
~60% judge-investigate rate on sdd-escalates/brainstorming — symmetric
across arms (no bias) but it halves codex-side power; audit queued. (4)
Fractals: 8/8 runnable cells pass or single-indeterminate across arms and
all three credentials — the 32/32-era reliability holds on Opus 5.

**Offline queue (task #5):** Opus-5 sdd-escalates transcript read; rep-1
breaker rescore; codex investigate audit; codex-dev ruling-shape gap
(1/3) read; seat-scan S7 counter (`parent_id`); codex wait-stretch
histogram; then the S1/S5/S2 analyzers validated on the 200 pre-existing
SDD trajectories. Next-week work: B1 router scenario (router-vs-null),
funded by the ~$750 the tripwire shape saved.

## Offline pass (2026-08-07 evening; four parallel transcript analysts)

**Retraction:** the read-out above attributed the codex investigate wave to
"substantive judge deliberations." Wrong — it was an **OpenAI credits
outage** (~13:27Z–17:39Z, recovered by 19:28Z): every sampled codex
investigate on sdd-escalates and brainstorming cites "no credits
remaining"; the agent never ran. Perfectly symmetric (6/6 per arm both
scenarios) → pure power loss, no bias. Judges were correct in every
sampled verdict tonight (0 waffles). The pre-outage clean codex escalates
cells split main 0/4 vs dev 4/4.

**Opus 5 × sdd-escalates: genuine model propensity, instrument valid.**
All 20 opus5 runs behave identically: invoke SDD, detect the 40-vs-30
contradiction at preflight, then call AskUserQuestion and wait —
reclassifying the conflict as "product intent, not technical" to exploit
the skill's own escape hatches ("stop only if every path is a guess";
no-spec-makes-rulings-provisional). Opus 4.8 uses the same rationalization
1/10; Opus 5 uses it 10/10. Everything else (structure, code, disclosure,
merge) is intact. The dev text flips 4.8 from 0/10 to 9/10 and moves
Opus 5 not at all. → This is the SDD escalation-classifier work item, now
with a named loophole to close. Two side-findings: a reviewer subagent
REVERSED a correct autonomous ruling in one run ("you weren't entitled to
rule alone") — reviewer prompts must not relitigate ruling authority; and
checks.sh's literal `repeat(40)` grep false-flags `const BANNER_WIDTH =
40` (bit 3/10 dev-opus5 runs; immaterial tonight, fix anyway).

**Rep-1 breaker rescore (from tool-call args + surviving ledgers, all
high-confidence):** structural-blocks rep 1 corrects 2/6 → **6/6 pass**
(four workspace-deletion false-fails) — the scenario is arm-neutral-clean
across the whole campaign. rules-and-continues rep 1: dev claude 2/2
PASS, main 0/3 (by construction — `Ruling:` exists only in dev's skill),
dev codex 0/1.

**Codex ruling gap is FORMATTING, not behavior.** All dev-codex
rules-and-continues runs adjudicated, continued, and wrote capital-label
rulings — as `Ruling: <what> because <why> — cost if wrong: <cost>` (one
em-dash where the regex demands two). Behaviorally 4/4; the single scored
pass was an incidental two-em-dash housekeeping ruling. The dev SKILL
itself sanctions two-part shapes (lines 416/422). → Corpus fix: loosen
the check to `Ruling: .+ — .+` (case-sensitive keeps the main-arm
discriminator — main's labels are lower-case) or accept "because" as the
why-separator. With that, dev codex ≈ 4/4 and the codex column matches
claude.

**codex-tool-mapping-comprehension is VOID on both arms** — it tests a
mapping table deleted by e7ddc25e ("Prune per-harness tool-mapping
boilerplate", 2026-06-30); the judge's premise dispute is correct; the
lone dev "fail" is the same fixture defect scored harsher. Void all 8
results; no valid signal from this scenario since June 30. Fix: rewrite
against content both arms ship + a pre-phase `file-contains` premise
guard so future rot becomes a deterministic preflight failure.

**Two harness leaks found (severity: harness, file separately):** (1)
answer-key leak — the agent under test located and read the eval's own
story.md acceptance criteria and copied the expected output; (2)
cross-run isolation leak — `find /workspace` exposed other concurrent
runs' staged trees.

**S7 no-subagents contract:** 0 violations / 451 claude seats + 184 codex
threads, both arms (independent checks: spawnDepth — 100% populated
tonight — and in-seat Task/Agent calls; codex parent_thread_id). Floor
holds; dev regresses nothing.

**S4 codex wait discipline:** dev ELIMINATED the blown-wait tail — main:
82 waits, median 10 min, 20.7% >10 min, tail to 60 min; dev: 117 waits,
74% at exactly 5 min, **0% >10 min** — but via 5-minute polling
(waits/spawn 1.14 vs 1.01, send_input 15× vs 1×). The tail is gone at the
cost of more controller wakeups; net token effect needs the transcript
token accounting before calling it a win.

**Recommended tickets:** (1) harness credits/infra-failure detector →
mark runs infra-failed + retryable instead of burning judge verdicts; (2)
the two isolation/answer-key leaks; (3) tool-mapping scenario rewrite +
premise guards; (4) rules-and-continues regex loosening; (5)
sdd-escalates behavioral check replacing the repeat(40) grep; (6) SDD
escalation-classifier skill iteration targeting the Opus-5
"product-intent" loophole + reviewer-authority seam.

**Token/wall-time deltas (medians, agent-ran cells).** Overall dev +12%
tokens/run (+5% wall) — a mix of three stories: (1) paying for completion
(escalates opus4.8 +50% tokens but 0/10→9/10; structural-blocks opus5
+114% — dev builds Task 3 where main stops); (2) efficiency wins where the
diff targeted cost (cost-spec −12/−38/−12% by column — the Spec: header
measured; brainstorming-resists −11 to −26%; triggering-tdd −39 to −47%
while improving); (3) like-for-like overhead on fractals, where both arms
fully succeed: codex +5%, opus4.8 +6%, **opus5 +28% tokens** — the real
per-process cost of dev (ledger rulings, preflight, wait-polling) on the
users' model; next token-objective target, to be measured with SUP-196
transcript accounting (totals here are cache-read-dominated).

## Alternative considered (the minimal night)

Run on existing `opus_bedrock` (Opus 4.8), skip the evals commit, credential,
and new scenario; drop breaker pair + calibration. ~$500 all-in, launchable
immediately. Rejected in design because it gates the release on a model users
aren't running and leaves S1 with no live discriminator — but it remains the
fallback if the smoke fails on either new element.
