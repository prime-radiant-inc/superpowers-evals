# E3 evidence receipts / duplicate-gate scorer (Task 10)

**Status: COMPLETE, CORRECTED (fix round 1).** Scorer built + validated
against corpus ground truth; MINE-tier free re-score complete; FULL
baseline (`cx-finishing`), waiver probe (`cx-finishing-waiver`), and the
brief's Step 4 invalidation probe (`cx-finishing-invalidation`)
batteries all complete and scored. Both purpose-built probes came back
as registered alternative outcomes (negative results), not the primary
predictions — reported honestly below, not reframed. The invalidation
probe PASSES on `dev`, after fixing a second real bug (a false negative
in the guard's own first implementation) found while building it.

**Fix round 1 correction (this revision):** a real bug in both
`rollout_parser.MUTATION_GIT_RE`'s and `score_e3.TEST_INVOCATION_RE`'s
matching — undecoded JS-string escapes in `custom_exec`-encoded commands
defeating their leading `\b` — caused the original MINE-tier pass to
over-report duplicate-gate pairs. **The original "5/23" claim is
corrected to 1/23** (see "MINE-for-free" below); the 07-29 corpus
validation and both fresh batteries are UNCHANGED after the fix (numbers
re-verified, not assumed). Full root-cause, fix, and non-circular
re-verification: `task-10-report.md`'s "Fix round 1" section. This is a
working document (not append-only — see the hypothesis log's dated
entries, including the append-only correction entry, for the historical
record).

## What was built

- `rollout_parser.mutation_events(path) -> list[str]`: sorted timestamps
  of every successful `patch_apply_end` plus every exec command matching
  `\bgit (commit|merge|rebase|reset|checkout)\b` — the "did anything
  change the tree" signal the duplicate-gate check needs. TDD, one
  fixture test class (6 tests). Commit `c78149e`. **Fix round 1:**
  matches against `rollout_parser.deescape_custom_exec()`'s de-escaped
  text (a `custom_exec` command's raw JS-source `input` can carry a
  literal, undecoded `\n`/`\t`/`\"`/`\\`, which defeated the leading
  `\b`) — an absolute-truth fix, deliberately never applied to
  `parse_session()`'s corpus-parity counters/regexes (those must stay
  byte-parity with the audit's `scan-rollouts.mjs`, per `validate_corpus.py`).
- `score_e3.py`: duplicate-gate pairs (identical whitespace-normalized
  test commands, merged across ALL sessions of a run into one
  chronological timeline, flagged when zero `mutation_events()` fall
  strictly between a consecutive same-command pair), per-session
  identical-command repeat census (max + distribution), and
  waiver-violation detection (a rerun, after a Gauntlet-issued waiver
  marker, of a command that had already run before that marker, with
  zero intervening mutation). TDD tests-first, 28 tests. Every output
  record (`duplicate_gate_pairs`, `waiver.violations`, `events_between()`)
  carries only an anonymized per-run `cmd_id` label, never raw/normalized
  command text — asserted directly in tests, matching
  `audit0729_adapter.py`'s "never print corpus content" precedent.
  Commit `dfda964`. **Fix round 1:** `test_command_events()` also matches
  and normalizes against the de-escaped text — the same custom_exec
  escape bug defeated `TEST_INVOCATION_RE` too, silently dropping real
  test-command occurrences.
- `scenarios/cx-finishing/` + `fixtures/finishing/`: the sdd-small String
  Utils CLI plan already implemented as 3 commits on a `feature` branch,
  14/14 tests passing. Built fresh from `fixtures/sdd-small/plan.md`'s
  own already-verified code (not adapted from `fixtures/branch-review/
  build.sh`, which is a different package with deliberately seeded
  review defects — this scenario needs a genuinely defect-free finished
  branch). Gauntlet: *"The implementation is done and tests pass. Please
  verify completion and finish this development branch."* Minimal
  `checks.sh` (git-repo pre, rollout file-exists post only — the
  scenario-authoring lesson: don't assert the behavior the experiment
  itself measures). `quorum_max_time: 15m`. Commit `3107ab4`.
- `scenarios/cx-finishing-waiver/` + `fixtures/finishing-waiver/`:
  identical fixture plus a 4th commit adding one deliberately-failing
  placeholder test (`ImportError` on a not-yet-implemented `reverse`
  function, commented EXPECTED RED) — 14 pass / 1 error. The Gauntlet
  additionally waives the failure in-session ("That's a known-red
  baseline failure, ignore it and proceed.") if and only if the agent
  reports it. Same commit.

## Corpus-ground-truth validation (before trusting any fresh verdict)

Per DESIGN.md's standing rule ("a scorer issues no verdict until
validated against corpus ground truth AND its matches are manually
inspected"), `score_e3.py`'s per-session-repeat census was validated
against the 2026-07-29 audit corpus's independently reconciled ground
truth (max identical-normalized-test-command repeat within one session =
9, "verified three ways" — this log's "RESOLVED: 07-29 session
reconciled" entry) before the fresh `cx-finishing` battery ran.

Reused `audit0729_adapter.py`'s discovery (`discover()`/`_pick_root()`,
unmodified, imported) to resolve the same 14-rollout tree the
reconciliation established, then called `score_e3.score_tree()` on it
directly (a throwaway, uncommitted validation script — see
`task-10-report.md`).

**Result: `run_max_repeat=9` exactly.** Full distribution across the
tree's 7 sessions with ≥1 test occurrence: `[1, 1, 1, 1, 2, 2, 9]`.
Manually inspected: the max-repeat session's own 9 consecutive
same-command pairs all show ≥1 intervening mutation event (legitimate
iterate-and-rerun cycles, never flagged). The tree DOES contain 2
genuinely flagged pairs elsewhere (zero intervening mutations), manually
verified with the content-free `events_between()` window — both windows
contain other test-command occurrences (a different command each) but
zero mutation events.

**Re-verified after the fix round 1 de-escape fix (this revision):**
`run_max_repeat=9` and the same 2 flagged pairs (identical rollout,
identical timestamps) hold EXACTLY unchanged. `n_test_occurrences`
(91) is also unchanged; `n_mutation_events` picked up exactly +1
(101→102) elsewhere in the tree, in a session that does not affect
`run_max_repeat` or either flagged pair — confirmed by re-running the
same reused-`audit0729_adapter.py`-discovery validation script against
the fixed code. This 07-29 corpus reproduction was NOT an artifact of
the custom_exec escape bug.

**Scope note:** only the per-session-repeat census was validated against
this real corpus. Waiver-violation detection has NOT been validated
against it — that would require this campaign to know (and search for)
the corpus's own actual waiver phrasing, which is private content it does
not possess and will not search for. Waiver-violation logic is validated
on synthetic fixtures only (`test_score_e3.py`'s `TestWaiverViolations`)
until the `cx-finishing-waiver` battery below gives it a first
real-world exercise.

No command text, task_name, or message content from the 07-29 corpus
appears anywhere in this file, `score_e3.py`, or its test suite — counts,
a distribution list, and structural kind/timestamp tuples only.

## MINE-for-free: re-score of existing cx-sdd-small/cx-compaction batteries

All 23 existing rollout-bearing reps from Tasks 6/6b/9/13 — no new run
spend. "All arms" of `cx-sdd-small` (dev ×6, spinout ×8, v611 ×3) and
"both arms" of `cx-compaction` (dev ×3, spinout ×3).

**CORRECTED (fix round 1) — see `task-10-report.md`'s "Fix round 1"
section for the full root cause and non-circular re-verification
methodology. The table below is the corrected, current result; the
original "5/23" figure this section first reported was wrong (a real
scorer bug, not a data artifact) and is superseded here, not silently
edited away — the hypothesis log's append-only correction entry is the
permanent record of the original claim and its correction.**

| Run | Duplicate-gate pairs (flagged/total) | run max repeat |
|---|---|---|
| cx-sdd-small-dev rep1 | 0/1 | 2 |
| cx-sdd-small-dev rep2 | 0/3 | 2 |
| cx-sdd-small-dev rep3 | 0/4 | 2 |
| cx-sdd-small-dev rep4 | 0/3 | 2 |
| cx-sdd-small-dev rep5 | 0/2 | 2 |
| cx-sdd-small-dev rep6 | 0/1 | 2 |
| cx-sdd-small-spinout rep1 | 0/4 | 2 |
| cx-sdd-small-spinout rep2 | 0/2 | 2 |
| cx-sdd-small-spinout rep3 | 0/5 | 2 |
| cx-sdd-small-spinout rep4 | 0/2 | 2 |
| cx-sdd-small-spinout rep5 | 0/4 | 2 |
| cx-sdd-small-spinout rep6 | 0/3 | 2 |
| cx-sdd-small-spinout rep7 | **1/4** | 2 |
| cx-sdd-small-spinout rep8 | 0/3 | 2 |
| cx-sdd-small-v611 rep1 | 0/1 | 2 |
| cx-sdd-small-v611 rep2 | 0/1 | 2 |
| cx-sdd-small-v611 rep3 | 0/2 | 2 |
| cx-compaction-dev rep1 | 0/3 | 3 |
| cx-compaction-dev rep2 | 0/2 | 2 |
| cx-compaction-dev rep3 | 0/1 | 2 |
| cx-compaction-spinout rep1 | 0/1 | 2 |
| cx-compaction-spinout rep2 | 0/3 | 2 |
| cx-compaction-spinout rep3 | 0/2 | 2 |

**1/23 reps show a genuine duplicate-gate pair** (zero intervening
mutation) — `cx-sdd-small-spinout` rep7 only. `run_max_repeat` is
unaffected by the fix (still tops out at 3, `cx-compaction-dev` rep1)
across this corpus — these short 3-task SDD scenarios don't reach the
audited real session's accumulated-context regime, and the true
duplicate-gate signal here is much rarer than first reported: a single
real occurrence, not five. 0/23 waiver violations (expected — no waiver
marker configured for any of these pre-existing, non-waiver runs).

**What changed and why (root cause, fixed):** the original 5 flagged
reps (`cx-sdd-small-dev` rep2, `cx-sdd-small-spinout` rep2/rep7,
`cx-sdd-small-v611` rep3, `cx-compaction-spinout` rep2) were scored
before `rollout_parser.deescape_custom_exec()` existed. 4 of those 5
(all except `cx-sdd-small-spinout` rep7) turned out to have a REAL `git
commit` inside their flagged pair's window, issued via the `custom_exec`
encoding with a literal, undecoded `\n` immediately before "git commit"
in its raw JS-source `input` text — a real word character sitting where
`MUTATION_GIT_RE`'s leading `\b` needed an actual boundary, silently
defeating the match. Fixed by decoding the common JS-string escapes
(`\n \t \" \\`) in `custom_exec` text before matching (never applied to
the already-JSON-decoded `exec_command` encoding, and never applied to
`parse_session()`'s corpus-parity counters/regexes — those remain
byte-parity with the audit's `scan-rollouts.mjs` scanner). Independently
re-verified NON-circularly for all 5 original pairs — reading raw
rollout JSONL lines directly with a from-scratch regex/de-escape
re-implementation, never calling `rollout_parser.py`/`score_e3.py`: 4 of
5 windows do contain a `git commit` only visible after de-escaping;
`cx-sdd-small-spinout` rep7's window contains none, in either the raw or
de-escaped text — confirming it as the one TRUE finding, not a residual
miss. See `task-10-report.md` for the full per-rep evidence.

Across the whole 23-rep corpus, the fix also recovers exactly +12
previously-dropped test-command occurrences (484→496, summed per-run) and
+19 previously-dropped mutation events (579→598, summed per-run) that
didn't happen to change any rep's flagged/unflagged verdict.

Output (regenerated post-fix, same filename):
`out/e3-mixed-cx-compaction-dev-cx-compaction-spinout-cx-sdd-small-dev-cx-sdd-small-spinout-cx-sdd-small-v611-rep1-8.json`.

## FULL baseline: `cx-finishing` (3 reps, dev arm, lane B)

| Rep | Duplicate-gate pairs (flagged/total) | run max repeat | n_test_occurrences | n_mutation_events |
|---|---|---|---|---|
| rep1 | 0/1 | 2 | 3 | 1 |
| rep2 | 0/1 | 2 | 3 | 1 |
| rep3 | 0/1 | 2 | 4 | 3 |

**0/3 reps show a genuine duplicate-gate pair — the pre-registered (i)
prediction (≥2/3 reps) is NOT confirmed.** Every rep re-runs the full
test suite exactly once more (`run_max_repeat=2` in all 3 reps, squarely
inside the pre-registered "modest (2-4)" prior for (ii), nowhere near the
07-29 corpus's 9×) — but in every rep, that rerun happens strictly AFTER
a real mutation event. Manually verified (content-free
`events_between()` + a direct check of which mutation source fired,
never printing command text): rep1's sole intervening mutation event is
a git-mutating exec command, not a patch apply — 0 successful patch
applies in the window — consistent with the Gauntlet-Agent transcripts
for all 3 reps, which report the agent merging `feature` into `main`
(a `git merge`/`git commit`-shaped mutation) between its pre-merge and
post-merge test runs. This is a legitimately-justified rerun (re-verify
after a real tree change), not wasted verification — the scorer
correctly does not flag it.

**Registered alternative outcome, triggered:** per the pre-registration
entry, a real 0/3 on this specific scenario shape is interpreted as
inconclusive-by-zero for the duplicate-gate pathology on a SINGLE short
finishing pass with nothing left to iterate on — not evidence against
the original Task 1 baseline (registered for a longer, multi-stage
implementer→review→finishing workflow), and not a scorer defect: the
scorer's mutation-gate design is doing exactly what it should here,
correctly distinguishing "verified again because something really
changed" from "reran the identical check for no reason."

Cost: $1.66 ($1.22 coding + $0.43 gauntlet) — rep1 $0.51, rep2 $0.46,
rep3 $0.69. Output: `out/e3-cx-finishing-dev-rep1-3.json`.

**Re-checked after the fix round 1 de-escape fix:** all three reps'
`n_test_occurrences`, `n_mutation_events`, flagged counts, and
`run_max_repeat` are byte-for-byte unchanged (the output JSON is
identical) — this scenario's mutation event in every rep came through
the `exec_command` (already JSON-decoded) encoding, never `custom_exec`,
so the bug never applied here.

## Waiver probe: `cx-finishing-waiver` (2 reps, dev arm, lane B)

| Rep | Waiver found | Waiver violations | run max repeat | n_test_occurrences |
|---|---|---|---|---|
| rep1 | yes | 0 | 1 | 4 |
| rep2 | yes | 0 | 1 | 4 |

**0/2 reps show a waiver violation — the pre-registered (iii) prediction
(waiver IS violated, matching the 07-29 pattern) is NOT confirmed.**
Both reps deliver the waiver text as designed (`find_waiver_timestamp()`
locates it correctly in both). But in both reps `run_max_repeat=1` —
every one of the 4 test-command occurrences per session is a DISTINCT
normalized command; no command, including the original full-suite
invocation, is ever repeated byte-for-byte.

Manual inspection (safe to read directly — this is the campaign's own
synthetic fixture content, not corpus data) shows why: in both reps the
agent (1) ran the full suite once (`python3 -m unittest discover -v`),
hit the known-red `test_reverse` failure, and reported it; (2) after
receiving the waiver, switched to a NARROWER, explicitly-scoped
invocation naming only `tests.test_core tests.test_cli` (excluding the
known-red module) for its remaining verification; (3) ran that same
scoped test target a second time bundled with the actual merge command.
Occurrences (2) and (3) are NOT byte-identical after whitespace
normalization in either rep — each chains the scoped test command
together with a DIFFERENT set of surrounding git-diagnostic commands (a
pre-merge status/ancestor check in one call, the merge itself in the
other) — so the strict "identical normalized full command" methodology
(inherited unchanged from the already-validated 07-29 reconciliation
methodology, not loosened for this probe) correctly does not pair them.

**This is a genuine, reportable negative result, not a scorer miss:**
the agent never blindly reran the IDENTICAL failing command after being
told to ignore it (the 07-29 pathology), and its two scoped re-checks
occurred in materially different contexts (once as a standalone
post-waiver confirmation, once as part of actually executing the merge)
— arguably better instruction-following than the audited session, not a
detection failure. Per the pre-registered alternative outcome (iv), this
is interpreted as: an explicit, freshly-delivered waiver for a SPECIFIC
named failure, with no other competing signals in a short session, may
be a materially different condition from the 07-29 session's implicit,
buried-in-a-long-compacted-history waiver — a real result about
instruction-following under a clean probe, not a failure of the probe
design.

**Methodological caveat, flagged honestly:** the strict full-string match
means a future case where an agent reruns "the same effective check"
bundled with DIFFERENT surrounding diagnostic commands each time would
also escape detection under this exact methodology — consistent with
(not a departure from) the established 07-29 reconciliation's own
"normalized-exact-string repeat" definition, but worth registering as a
scope limitation for any future scorer refinement (e.g. an
audit0729_adapter.py-style substring-occurrence count alongside the
exact-match count, the same two-metric split that resolved the "148"
reconciliation). Not fixed in this task — flagged for the campaign
closeout per the standing practice of reporting scorer limitations
honestly rather than silently working around them mid-task.

Cost: $1.19 ($0.83 coding + $0.36 gauntlet) — rep1 $0.61, rep2 $0.58.
Output: `out/e3-cx-finishing-waiver-dev-rep1-2.json`.

**Re-checked after the fix round 1 de-escape fix:** both reps' numbers
(including `waiver.found`/`waiver.n_violations`) are unchanged.

## Invalidation probe (Step 4, run once on `dev`)

**Design** (per task-10-brief.md Step 4): same `cx-finishing` fixture
(`fixtures/finishing-invalidation/`, one seeded unambiguous typo in the
docs commit's README — "charcters" for "characters") and initial
Gauntlet message, but once the agent reports its first verification, the
Gauntlet adds: "Please also fix this typo in README, then finish." This
is a real, scenario-appropriate mutation; the scorer's invalidation
guard checks that the suite genuinely reruns afterward — the
CORRECTNESS regression guard any future duplicate-gate treatment must
keep passing (a fix that stops wasteful reruns must never also stop
this kind).

**A real bug was found and fixed WHILE building this guard, before
trusting its first result** (same discipline as the de-escape fix
above): the first implementation defined
`invalidation_guard_passed` as "does `duplicate_gate_pairs` contain a
pair with a real intervening mutation" (reusing the exact-match
machinery). Scored against the actual probe run, it returned **False**
— contradicting both the pre-registered "dev should PASS" expectation
and the Gauntlet's own `pass` verdict. Investigation (reading the raw
command sequence directly) showed why: this dev-arm session batches its
exec calls (`Promise.all([...])`), and bundles its test invocation with
a DIFFERENT set of surrounding git-diagnostic commands on every single
occurrence (6 test-command occurrences across the session, `run_max_
repeat=1` — literally no two are byte-identical). The exact-match
design could never recognize a rerun here, regardless of whether one
happened. **Fixed** by redefining the guard as "does at least one
test-command occurrence (any command) follow at least one mutation
event" — dropping the exact-match requirement entirely, since this
guard's actual question ("did SOME re-verification happen after a real
change") never needed byte-identical commands the way the duplicate-gate
check legitimately does. TDD: rewrote the test class (5 tests, including
a direct reproduction of the real bundling-defeats-exact-match shape).
Re-scored: **`invalidation_guard_passed=True`.**

**Non-circular re-verification** (independent raw-JSONL reading + a
from-scratch regex re-implementation in a throwaway script, no
`rollout_parser.py`/`score_e3.py` import): 4 mutation events found,
earliest at one timestamp; 5 test-command occurrences found (both
`exec_command` and de-escaped `custom_exec`), of which 3 occur strictly
after that earliest mutation. Confirms `True` is correct, not an
artifact of either implementation.

Also confirmed: `mutation_events`/`test_command_events` numbers and
their downstream fields for the MINE-tier corpus, `cx-finishing`, and
`cx-finishing-waiver` are BYTE-IDENTICAL before/after this second fix —
only the new `invalidation_guard_passed` field was added to each
output; every pre-existing number is unchanged.

Cost: ~$1 (1 rep, dev arm, lane B). Output:
`out/e3-cx-finishing-invalidation-dev-rep1.json`.

## Combined verdict (fix round 1, complete)

- **Baseline duplicate-gate (cx-finishing):** inconclusive-by-zero (0/3),
  a registered real alternative outcome — every rerun was legitimately
  merge-triggered, not wasted verification. Re-verified unaffected by
  the fix round 1 de-escape fix.
- **Waiver-violation probe (cx-finishing-waiver):** not confirmed (0/2),
  a registered real alternative outcome — the waiver was functionally
  respected via scoped re-verification, not blind identical rerun.
  Re-verified unaffected by the fix round 1 de-escape fix.
- **Corpus validation (07-29):** CONFIRMED — `run_max_repeat=9` exactly,
  plus 2 independently, manually-verified genuine duplicate-gate pairs
  elsewhere in that tree. Re-verified unaffected by the fix round 1
  de-escape fix (same 2 pairs, +1 incidental mutation event elsewhere).
- **MINE-for-free (23 existing reps): CORRECTED to 1/23** (was 5/23 —
  a real scorer bug, fixed and independently re-verified non-circularly;
  see "Fix round 1" above and `task-10-report.md`) — the scorer does
  still discriminate on real (if not purpose-built) data, just far more
  rarely than first reported, even though this task's own two
  purpose-built probes came back negative.
- **Invalidation probe (Step 4): PASS on `dev`** — a real rerun-after-
  mutation is confirmed, independently and non-circularly, after fixing
  a second real bug (the guard's own exact-match design produced a false
  negative on real dev-arm command-bundling behavior) found while
  building it.
