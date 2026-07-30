# E6 compaction-recovery verdict: baseline `dev` vs. treatment `spinout` (Task 9)

**Status: baseline (3 reps) and treatment (3 reps) batteries complete,
scored, manually verified. Plus free re-scores of Task 6/6b's existing
`cx-sdd-small` corpus (dev/spinout/v611, 17 reps total, no compaction
knob) and Drew's stress-2703 corpus (external, the one real long-history
compaction specimen).**

**Headline:** the original compound baseline prediction splits cleanly
into its two clauses, same pattern as E1's axis split — one clause
(post-compaction spawn-hygiene degradation) holds, weakly but for the
first time anywhere in this campaign's dev-arm corpus; the other
(spontaneous skill re-reads) does NOT fire on the short, config-knob-
forced dev scenario at all, but IS confirmed both on the treatment arm
(mechanistically, via its recovery hook) and on the one real long-history
corpus available (Drew's stress-2703, organically, no hook). The
depth-2-implementer-spawned-reviewer + same-task-duplicate-review pattern
(Amendment 3's "4th occurrence") is now overwhelmingly confirmed: every
depth-2 spawn observed in this battery (4/4) was implementer-issued, and
same-task duplicate reviews appeared in the majority of dev reps (2/3).

## Mechanism (Task 9 Step 1, full detail in DESIGN.md)

`model_auto_compact_token_limit = 40000`, prepended to the codex agent's
config.toml by `scenarios/cx-compaction/setup.sh` before launch. Verified
with 2 cheap adhoc calibration runs before any battery spend, then
confirmed live in the real scenario: **100% of battery reps (6/6, both
arms) show ≥1 real compaction** — the mechanism is fully reliable, not a
fluke.

## (a) Post-compaction skill re-reads

| Arm | Reps w/ ≥1 compaction | Reps w/ ≥1 re-read | Total re-read events |
|---|---|---|---|
| dev (baseline) | 3/3 | **0/3** | 0 |
| spinout (treatment) | 3/3 | **1/3** | 1 |

The one spinout re-read (rep2) is a **direct, live confirmation of the
treatment mechanism working as designed**: the root controller re-read
`skills/subagent-driven-development/SKILL.md` after its first
compaction, having read it before — exactly what spinout's
`hooks/session-start-codex` (fires on Codex's `SessionStart`
`source:"compact"` re-injection) explicitly instructs ("Re-read the
SKILL.md of any skill you are mid-way through executing... re-read
skills/subagent-driven-development/SKILL.md").

**Zero re-reads on dev** is a real finding, not inconclusive-by-zero in
the E1-axis-B sense (that pattern needs corroboration to interpret, and
gets it two ways — see below):

- **Drew's stress-2703 corpus (real, long-history, no hook, external,
  read-only, never committed):** 68 rollouts, 25 total compactions (18
  root + 7 across 4 children). **The root DID organically re-read
  `skills/systematic-debugging/SKILL.md` after a compaction, having read
  it before** — one genuine clause-(a) instance, with no recovery hook
  present at all. So clause (a) CAN fire spontaneously, given enough
  real accumulated context/duration.
- Our own dev battery gives the controller only 2 compactions and a few
  turns of "before" activity per rep (a 3-task, ~15-25-minute session) —
  evidently not enough organic pressure to re-trigger a skill read
  without either a recovery hook (spinout) or the much larger real-world
  scale Drew's corpus represents (16,830 root lines vs. our ~360-430).

**Interpretation:** this is the nuanced version of the pre-registered
alternative outcome (iii) — not a clean "the rig can't reproduce this at
all" (real degradation AND real re-reads did occur elsewhere in this
same battery/corpus set), but a genuine, scenario-shape-specific finding:
**a short, forced-compaction scenario does not by itself generate enough
organic re-read pressure; eliciting it needs either a recovery mechanism
or much longer real sessions.**

## (b) Bootstrap/routing retention — spawn hygiene pre/post first compaction

| Arm | Pre spawns | Pre isolated | Pre explicit model | Post spawns | Post isolated | Post explicit model |
|---|---|---|---|---|---|---|
| dev (baseline) | 4 | 4/4 (100%) | 4/4 (100%) | 21 | 21/21 (100%) | **20/21 (95.2%)** |
| spinout (treatment) | 4 | 4/4 (100%) | 3/4 (75%)† | 21 | 21/21 (100%) | 21/21 (100%) |

† The one spinout pre-compaction omission (rep1) predates any
compaction and is unrelated baseline noise, not a compaction effect —
flagged, not hidden.

**Isolation (`fork_turns`) never degrades on either arm** — 100%
isolated in every pre/post bucket, both arms. Only model-explicitness
shows a signal, and only on dev:

**The one dev degradation is meaningful, not noise, in context.** It is
a **root-controller** dispatch (`final_reviewer_after_fix`, dev rep3,
timestamp `2026-07-30T07:13:08.330Z`, immediately post-compaction) that
omitted `model` — the config field `dev`'s own
`subagent-driven-development/SKILL.md` mandates be always explicit. Per
the E1 CLI-0.146 re-test entry in the hypothesis log, every
root-controller spawn scored anywhere in this campaign before E6 was
100% explicit-model: **45/45 combined across both arms of E1's CLI-0.146
corpus (dev 14/14 + spinout 31/31)** — the dev arm's own share of that
streak is 14/14. **This is the first such failure anywhere in this
campaign's dev-arm corpus at the field CLI version, and it happened
exactly at a post-compaction dispatch, on the arm with no recovery
hook.** One instance is a thin signal (1/21 post-compaction spawns), but
its direction is exactly the pre-registered prediction (i), and it breaks
a previously-unbroken streak — 14/14 on dev alone, 45/45 combined.

**Drew's stress-2703 corpus tells a different story on this specific
clause: ZERO degradation** — 5/5 pre and 78/78 post spawns are 100%
isolated/explicit, no hook present. This does not contradict the dev
finding so much as sit in tension with it; the Drew cross-validation
entry's own "compliant-controller caveat" already flagged that
particular session as unusually well-behaved even in windows with no
re-read prompt at all — a controller-compliance difference is a live,
undecided explanation, not resolved by this task.

## (c) Depth-2 spawns by role + same-task duplicate reviews

**Every depth-2 spawn observed anywhere in this battery (4/4) was
issued by an implementer, none by a reviewer** — dev rep1 (1), dev rep3
(2), spinout rep1 (1); spinout reps 2-3 had none. This is now one of the
most repeatedly-confirmed findings in the whole campaign.

**Terminology (this section counts by SPAWNER role).** "Depth-2 spawn by
role" here means *the role of the session that issued the spawn* — an
implementer child calling `spawn_agent` a second level down. The same
phrase in `out/e-audit0729.md`'s cross-corpus table counts by *child*
role (what the depth-2 child itself is). Both descriptions fit the same
underlying events: the observed shape is always an implementer spawning a
reviewer, so it is 100% implementer-issued by spawner role and 100%
reviewer by child role. Neither count is a disagreement with the other.

Tally, counting only depth-2-spawn-issued-by-implementer occurrences (not
requiring the stricter duplicate-review match below), deduplicated by
underlying run: Amendment 3's real 07-29 audit-tree session (1) + this
task's own new `cx-compaction` battery (4: dev rep1, dev rep3 ×2,
spinout rep1) + this task's free re-score of the EXISTING `cx-sdd-small`
corpus (3: spinout rep5, spinout rep8, v611 rep2) + Drew's stress-2703
(1: an implementer-role session spawning a reviewer-role child at depth
2 — task_name strings from this corpus are not cited, per the standing
never-commit rule) = **9 independently-confirmed occurrences across 4
distinct corpora/sources** (a real desktop session, two of our own
quorum battery families, and one external corpus), **with zero
counter-examples** — no reviewer-spawned depth-2 child was ever observed
anywhere, in any corpus this campaign has scored.

**Correction (this was "11 across 5 corpora" in an earlier draft of this
report):** the earlier tally added "the E1 CLI-0.146 re-test's own
battery (2)" as a separate source. It is not one — the E1 re-test's
treatment arm IS `cx-sdd-small` spinout rep5-8, the same runs the free
re-score covers, so its 2 depth-2 spawns are the same two events already
counted as "spinout rep5, spinout rep8". Verified by summing
`depth2_details` across every E6-scored run: `cx-compaction` dev 3 +
`cx-compaction` spinout 1 + `cx-sdd-small` spinout 2 (rep5, rep8) +
`cx-sdd-small` v611 1 + `cx-sdd-small` dev 0 = **7 in-campaign
occurrences**, plus the 07-29 session (1) and Drew's stress-2703 (1) =
**9 distinct**. `duplicate_review_families` sums to 7 over the same runs,
so all 7 in-campaign occurrences — and, with 07-29 and Drew, all 9 — also
match the stricter same-task-duplicate pattern. See the hypothesis log's
dated correction entry.

**Terminology (E6's "duplicate review" is not E5's).** E6 scores a
**same-task** duplicate: two reviews of the *same task family*, one of
them worker-initiated at depth 2, the other controller-initiated at depth
1 — the recursion-shape measure Amendment 3 registered. E5
(`out/e5-report.md`, "same-scope duplicate review") scores a different
thing: two reviews covering the *same review scope* regardless of who
issued them or at what depth, which is why E5 can report 0/3 in a
battery where E6-style same-task duplicates are common. The two measures
are complementary, not competing counts of one phenomenon.

**Same-task duplicate reviews** (a worker-initiated depth-2 review of a
task, alongside a separate controller-initiated depth-1 review of the
*same* task — the Amendment-3 "4th occurrence" pattern): **2/3 dev reps**
(rep1: task1; rep3: task1 AND task3 — two independent instances in one
rep) and **1/3 spinout reps** (rep1: task1). All manually verified
against the raw session tree (task_name/depth/parent_rollout), not taken
on the scorer's word alone.

**A real bug was found and fixed via this manual verification, not
glossed over:** dev rep1's controller-initiated duplicate review of task1
was named `task1_controller_review` — a wording the original
`task_family()` suffix-stripping heuristic (built from the prior
`cx-sdd-small` corpus's `task1_reviewer`/`task1_implementer` convention)
did not match, so the scorer initially reported **zero** duplicates for a
rep that plainly has one. Fixed with 4 new TDD tests before re-scoring
anything (commit `99c5ad7`); the fix is a broader task-family PREFIX rule
(`task<N>`/`final`) that subsumes the old suffix-based fallback, verified
non-regressive against every prior corpus already scored.

## (d) Controller input growth

| Arm | Rep | Root lines | Root compactions |
|---|---|---|---|
| dev | 1 | 433 | 2 |
| dev | 2 | 360 | 2 |
| dev | 3 | 381 | 2 |
| spinout | 1 | 519 | 3 |
| spinout | 2 | 431 | 2 |
| spinout | 3 | 367 | 2 |

For reference, Task 6's un-forced `cx-sdd-small` dev baseline (no
compaction knob) peaked at 302-405 lines with **zero** compactions across
14 reps — the knob reliably adds real compaction-recovery overhead (2-3
events, ~15-25% more root lines) without derailing task completion (6/6
`gauntlet.status: pass`, all three plan.md tasks addressed, clean merges
to `main`, all unit tests passing, in every rep both arms).

Total compactions across the tree (not just root) also differ: dev 6 (all
root — no child ever compacted), spinout 10 (7 root + 3 across children)
— children compacting independently matches
`docs/2026-07-29-codex-multiagent-v2-capabilities.md`'s documented
behavior ("children compact independently; no parent notification").

## Free re-score of existing corpus (no new run spend)

**Task 6/6b's `cx-sdd-small` battery (no compaction knob — negative
control for "does compaction happen incidentally"):**

| Corpus | Reps | Compactions | Same-task duplicate review |
|---|---|---|---|
| dev rep1-6 | 6 | 0/6 | 0/6 |
| spinout rep1-8 | 8 | 0/8 | **2/8** (rep5: task2; rep8: task1) |
| v611 rep1-3 | 3 | 0/3 | **1/3** (rep2: task2) |

Zero incidental compactions anywhere, as expected (these short, un-forced
sessions never approach any sensible default token limit). The
duplicate-review pattern, however, is present in this pre-existing
corpus too — 3 MORE independently-confirmed occurrences, all manually
verified against the raw session tree, spanning both CLI/skill-version
combinations this campaign has tested (spinout at CLI 0.146, v611 at CLI
0.146 with the pre-fix skill content) — reinforcing that this recursion
shape is not new, not compaction-dependent, and not skill-version-
dependent.

**Drew's stress-2703 corpus (external, read-only, never committed;
reference condition — the one corpus with genuine long-history
compaction under real load):** see (a)/(b)/(c) above for the specific
numbers. Summary: 25 total compactions (18 root), 1 genuine skill
re-read, 0 spawn-hygiene degradation across 78 real post-compaction
spawns, 1 more implementer-spawned depth-2 spawn (task_name strings from
this corpus are not cited, per the standing never-commit rule). **This
depth-2 spawn's family DOES resolve under the post-fix `task_family()`**
(re-run directly against `score_tree()` after commit `99c5ad7`, not
assumed): the implementer's task_name matches the `task<N>` prefix rule,
giving family `task12`, and that family also has a separate root-
initiated review — i.e. this Drew occurrence is a genuine, confirmed
same-task duplicate review too, not a scoped-out miss (an earlier draft
of this report claimed the opposite, based on a stale pre-fix run that
was never re-executed after `99c5ad7` landed; corrected here, see the
hypothesis log's dated correction entry and `task-9-report.md`'s fix
report for the full account).

## Discrimination gate

Per the standing rule, the original compound prediction ("≥1 re-read
AND ≥1 degraded spawn") is evaluated as registered. **Split verdict**,
same pattern as E1's axis split:

- **Clause (a) re-reads: does NOT hold on the dev baseline battery**
  (0/3 reps, 0 events) — inconclusive-by-zero on THIS scenario shape
  specifically, not on the underlying pathology (confirmed elsewhere:
  spinout 1/3, Drew's real corpus 1/1 sessions-with-compaction-that-
  re-read-anything).
- **Clause (b) degradation: holds, narrowly** (1/21 post-compaction
  spawns on dev, 0/21 on spinout) — a real, if thin, signal that breaks
  a previously-unbroken root-controller explicit-model streak (14/14 on
  the dev arm alone, 45/45 combined across both E1 CLI-0.146 arms), in
  exactly the predicted direction and exactly at the predicted boundary.
- Sharpened prediction (i) (hygiene drop on dev vs. flat on spinout):
  **confirmed directionally**, modest in magnitude.
- Sharpened prediction (ii) (depth-2 concentrated in implementer
  spawners + same-task duplicates): **strongly confirmed**, now the most
  repeatedly-reproduced finding in the campaign (**9** depth-2-by-
  implementer occurrences across **4** corpora/sources, **all 9** also
  matching the stricter same-task-duplicate-review pattern — 0
  counter-examples). Two corrections landed on this tally: an earlier
  draft said "8" same-task duplicates, omitting Drew's stress-2703
  occurrence on a stale pre-fix run (see the Concerns section), and the
  occurrence total was "11 across 5 corpora" until the E1-re-test /
  `cx-sdd-small`-spinout double-count was removed (see the correction in
  section (c) above).
- Sharpened prediction (iii) (rig-can't-reproduce alternative outcome):
  **not triggered as a clean terminal finding** — real signal exists on
  both clauses somewhere in the evidence base — but its NUANCED form
  (short scenarios don't organically elicit re-reads without a hook or
  much longer real sessions) is itself a genuine, registered-in-advance
  finding, not a post-hoc rationalization.

**E6 is DONE, mixed result, honestly reported in both directions** — the
same character as E1's axis split and E4's mixed ceremony finding, not
collapsed into either a clean pass or fail.

## Budget ledger

| Date | Battery | $ cost | Sub used_percent before | Sub used_percent after |
|---|---|---|---|---|
| 2026-07-30 | E6 calibration (2 adhoc `codex exec` runs, no gauntlet) | ~$0.4 (uninstrumented — raw `codex exec`, not quorum-priced; ~264K tokens combined) | -- | -- |
| 2026-07-30 | E6 baseline (dev, cx-compaction, 3 reps, lane A) | $12.66 ($11.56 coding + $1.10 gauntlet: rep1 $4.11+$0.45, rep2 $3.50+$0.33, rep3 $3.95+$0.32) | 56.0% | -- |
| 2026-07-30 | E6 treatment (spinout, cx-compaction, 3 reps, lane B, JOBS=2) | $13.06 ($11.98 coding + $1.09 gauntlet: rep1 $4.71+$0.41, rep2 $3.94+$0.36, rep3 $3.33+$0.32) | -- | 58.0% |

E6 total: **~$26.12**. Campaign running total (previous $104.45 + this
battery): **≈$130.57**, well under the $250/$1000 checkpoints. Free
re-scores (existing `cx-sdd-small` corpus + Drew's stress-2703): no
additional spend.

## Concerns / scope notes

1. **`task_family()`'s task<N>/final-prefix convention is specific to
   this campaign's own SDD fixture** and does not generalize to
   arbitrary corpora — confirmed by its correct non-match on Drew's
   corpus's own, differently-shaped task_name convention (not cited here
   per the standing never-commit rule). Duplicate-review detection on
   any future external corpus needs its own naming-convention check
   before trusting a zero result as a true negative.
2. **The dev-arm degradation signal is thin** (1/21 post-compaction
   spawns) — real and correctly in-direction, but a single rep drove it
   (dev rep3); do not over-claim a robust effect size from n=1.
3. **Drew's stress-2703 shows zero hygiene degradation** despite 78 real
   post-compaction spawns — in tension with (if not necessarily
   contradicting) the dev-arm finding; the "compliant-controller caveat"
   from the original Drew cross-validation entry is the leading
   explanation, not re-investigated here.
4. **No treatment-vs-baseline statistical test** — n=3 reps/arm, exactly
   as pre-registered; all verdicts above are directional/qualitative,
   consistent with every other battery this campaign has run at this
   scale.
5. **Total-tree compactions differ by arm (dev 6, spinout 10)** —
   children compacting independently (spinout has more/longer child
   sessions in this sample) rather than a root-controller effect; not
   further investigated as it's outside E6's four registered questions.

Findings log entries: `logs/2026-07-28-codex-efficiency.md`, "E6
PRE-REGISTRATION" and "E6 RESULT" entries. Raw per-rep JSON:
`out/e6-cx-compaction-dev-rep1-3.json`, `out/e6-cx-compaction-spinout-rep1-3.json`,
`out/e6-cx-sdd-small-{dev-rep1-6,spinout-rep1-8,v611-rep1-3}.json`
(aggregates/tuples only — no message/instruction text, matching every
other scorer's output in this campaign).
