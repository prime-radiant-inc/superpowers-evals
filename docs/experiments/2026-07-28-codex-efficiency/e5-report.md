# E5 review-scope / seeded-defect recall scorer (Task 12)

**Status: fixture + scenario + scorer built and validated (TDD, 39
tests); MINE-tier free scan complete; FULL baseline (`cx-scope-review`,
dev arm, 3 reps) complete.** This is a working document (not
append-only — see the hypothesis log's dated entries for the
append-only history and the pre-registered predictions).

## What was built

- `fixtures/scope-review/build.sh`: a small two-module Python project
  (`mtqueue`, a thread-safe producer/consumer queue) with a `main`
  baseline and a 3-commit `feature` branch adding a batch API. Three
  defects planted, each requiring a different review scope to catch —
  full detail + exact file:line + detection rubric in
  `out/e5-defect-key.md`:
  - **D1** (local/task scope, unit-testable): `mtqueue/batch.py:3`'s
    `DEFAULT_BATCH_SIZE = 1` should be 5 per `docs/BATCH.md` — a shipped
    test (`test_drain_batch_default_pulls_documented_batch_size`) is RED
    against this branch.
  - **D2** (cross-commit/cross-task scope, NOT unit-testable):
    `mtqueue/queue.py:31-34`'s new `peek_batch()` reads `self._items`
    without acquiring `self._lock`, unlike every sibling method and
    unlike the explicit thread-safety contract `docs/DESIGN.md`
    established on `main` before the branch existed. The shipped suite
    exercises it only sequentially, so it passes cleanly.
  - **D3** (clean-checkout scope): `mtqueue/batch_codec.py:3` imports
    `msgpack`, absent from `pyproject.toml`'s dependencies;
    `docs/DEV_SETUP.md` documents the gap as a TODO the author never
    did. A real `ModuleNotFoundError` fires the moment `pytest` collects
    `tests/test_batch_codec.py` in any environment without `msgpack`
    preinstalled (verified: none is, in this fixture's own validation
    run).
  - `pyproject.toml`'s `[tool.pytest.ini_options] addopts =
    "--continue-on-collection-errors"` (set on `main`, before D3
    exists) keeps D1's failure visible in a plain `pytest tests/` run
    even though D3 also fires in the same run — verified directly
    (`1 failed, 8 passed, 1 error` on the rendered fixture).
  - D4 is not fixture content: it's whatever the coding agent's
    mid-session repair (requested by the Gauntlet after D1's own
    symptom is reported) actually does — scored structurally, not by
    keyword (see below).
- `scenarios/cx-scope-review/{story.md,setup.sh,checks.sh}`: Gauntlet
  opens with *"Please run your full review process on the feature
  branch and get it ready to merge."*; if and only if the agent reaches
  a first completion claim, the Gauntlet reports D1's own symptom
  ("...only gave me back 1 item instead of the 5 the docs promise...")
  and asks for a fix; once fixed, "Thanks, that's what I needed."
  `quorum_max_time: 30m`. `checks.sh` is deliberately minimal (git-repo/
  git-branch pre, rollout file-exists post only — no `tool-called
  Agent` assertion, since dispatch behavior is exactly what this
  experiment measures, the same E2/E4 scenario-authoring lesson already
  in the ledger).
- `score_e5.py` (TDD tests-first, 39 tests in `test_score_e5.py`): six
  measures per run —
  1. **Recall matrix**: each defect's rubric keywords searched across
     every session's `task_complete.last_agent_message` and
     `agent_message`/`phase=="final_answer"` text; each hit attributed
     to a review pass (root: pre- vs post-repair-request timestamp;
     dispatched sessions: their own parent-assigned task_name).
  2. **Scope accretion**: `git commit` events strictly after the run's
     first `task_complete` (first completion claim).
  3. **Same-scope duplicate review** (Amendment 3): 2+ dispatched
     REVIEWER-role sessions (role + family via `score_e6`'s
     `classify_role_by_task_name()`/`task_family()`, reused unmodified)
     sharing a family — scoped to reviewer-role only so an ordinary
     implementer+reviewer pair is never misflagged.

     **Terminology: this is NOT E6's "same-task duplicate review."**
     E5's measure counts two *reviewer-role* sessions covering the same
     review scope, whoever dispatched them and at whatever depth. E6's
     (`out/e6-report.md`, section (c)) counts a *worker-initiated
     depth-2* review of a task alongside a separate
     *controller-initiated depth-1* review of the same task family — a
     recursion-shape measure that requires the depth/issuer pattern. A
     corpus can therefore score 0 on E5's measure and nonzero on E6's
     (and this campaign's batteries do exactly that); the two numbers
     are complementary, not rival counts of one phenomenon.
  4. **Serial-remediation cycles** (Amendment 3): post-repair
     test-command reruns (`score_e3.test_command_events()`, reused)
     minus 1.
  5. **Wave-boundary violation** (Amendment 3): a mutation event
     (`rollout_parser.mutation_events()`, reused) attributed to a
     session other than an active fix-review, inside that fix-review's
     own lifetime window.
  6. **D4 fix-review scope**: whether every post-repair test command
     names a specific file (`repair_scoped`) or at least one is a
     whole-suite rerun (`full_branch_rescope`) — a coarse structural
     proxy, always paired with a manual read of the actual transcript.

## Fixture validation (before any battery spend)

Rendered the fixture directly (`bash fixtures/scope-review/build.sh` in
a scratch dir) and confirmed all three defects behave exactly as
designed: `pytest tests/` shows `1 failed, 8 passed, 1 error` — D1's
test fails with `assert [0] == [0, 1, 2, 3, 4]`; D3's
`tests/test_batch_codec.py` errors at collection with
`ModuleNotFoundError: No module named 'msgpack'` (confirmed `msgpack`
is not installed in the validation environment); D2's
`test_preview_does_not_remove_items` passes cleanly (single-threaded,
never exercises the race). `bun run quorum check cx-scope-review`
passes (`ok cx-scope-review`, `ok credentials`).

**Naming-convention bug caught and fixed before any paid spend:**
`run-quorum.sh` derives a scenario's fixture directory as
`fixtures/<scenario name minus its "cx-" prefix>` — the fixture
directory was initially named `scope-defects` (matching
task-12-brief.md's suggested name literally) instead of `scope-review`
(matching the actual scenario id `cx-scope-review`), which every other
scenario in this campaign follows without exception
(`branch-review`/`cx-branch-review`, `compaction`/`cx-compaction`,
`finishing-waiver`/`cx-finishing-waiver`, etc.). The first battery
attempt (2 reps, JOBS=2) failed immediately with `setup.sh failed (exit
127)` / `No such file or directory` for `fixtures/build.sh` — caught at
$0 cost (both reps landed `indeterminate` before any Codex session
started), fixed by renaming the directory, re-validated with `bun run
quorum check`, then re-run.

## MINE-tier free scan (zero cost, before the paid battery)

Ran `score_e5.py`'s four RECALL-INDEPENDENT measures (same-scope
duplicate review, scope accretion, serial-remediation cycles,
wave-boundary violations) over existing corpora — NOT the recall
matrix, which is only meaningful against the `scope-review` fixture
itself (these corpora use entirely different fixtures, so any D1/D2/D3
"hit" there is fixture-mismatched noise, not a real signal, and is
excluded from this summary):

| Corpus | Reps | Same-scope duplicate review | Accretion commits (total) | Remediation cycles | Wave violations |
|---|---|---|---|---|---|
| `cx-branch-review` (E2, dev, lane A) | 4 | 0/4 | 0 | 0 | 0 |
| `cx-compaction` (dev, lane A) | 3 | 2/3 (families `task1`/`final`) | 12 | 0 | 0 |
| `cx-compaction` (spinout, lane B) | 3 | 3/3 | 9 | 0 | 0 |
| 07-29 audit corpus (fetched, counts only) | 1 tree (14 sessions) | 0 (see note) | 16 | 0 | 0 |

Remediation cycles and wave violations are structurally 0 across every
one of these corpora because none of them contain `cx-scope-review`'s
own fixed repair-request marker — the correct answer, not a broken
measure (each scenario's own `repair_request_timestamp` reads back
`None`, confirmed directly).

**Correction applied before finalizing this table (own defensive fix,
prompted by the concurrent E3 fix-round-1 correction landing in this
same log while this task was in flight):** `score_e5._git_commit_events()`
calls `rp.exec_commands()` directly with its own `GIT_COMMIT_RE`, the
same shape of call site `rollout_parser.mutation_events()` and
`score_e3.test_command_events()` needed `rp.deescape_custom_exec()` for
(Task 10 fix round 1: a `custom_exec` command's raw, un-JSON-decoded
input can carry a literal two-character backslash-n that defeats a
leading `\b`-anchored regex). Added the same de-escape call (TDD, one
new regression test), re-verified: this task's own `cx-scope-review`
battery numbers were UNCHANGED (no affected commands in these 3 reps),
but the MINE-tier `cx-compaction` spinout total corrected from 7 to 9
accretion commits (2 real `git commit`s, previously silently dropped by
the same undecoded-escape pattern, now counted) — the table above
already reflects the corrected number.

**07-29 corpus note:** `same_scope_duplicates` returns 0 there not
because no duplicate review occurred (the audit's own hand-verified
finding, `e-audit0729.md` claim 5, is a real, confirmed instance) but
because `score_e6.task_family()`'s regex — built for this campaign's
own `task<N>_role` naming convention — doesn't recognize that corpus's
own naming convention, which puts the role word as a PREFIX ("review of
X", "re-review of X") rather than this campaign's own task<N>-then-role-
SUFFIX shape, so the implementer's and its reviewers' task_name strings
never reduce to a shared family under this regex. Cross-checked
directly: `score_e6.score_tree()` run against the identical discovered
tree ALSO returns 0 `duplicate_review_families` on this corpus — the
same, honest, naming-convention limitation of the reused function, not
a bug specific to this scorer. (Per this campaign's standing rule, no
literal task_name string from this external corpus is quoted here or
anywhere in this report — `e-audit0729.md`'s own precedent for this
corpus uses generic descriptive labels like "the 'catalog' implementer"
only, never the literal identifier strings, and this note follows that
same precedent rather than the looser "fractals task_names are
citable" rule, which applies to Drew's SDD-taxonomy corpus, a different
corpus with a different, already-reviewed citability determination.)

Full per-rep detail: `out/e5-cx-branch-review-dev-rep1-4.json`,
`out/e5-cx-compaction-dev-rep1-3.json`,
`out/e5-cx-compaction-spinout-rep1-3.json` (the 07-29 corpus scan used a
throwaway, uncommitted script per this campaign's standing "no
external-corpus content committed" rule — counts only, reproduced in
this report and the log).

## FULL baseline: `cx-scope-review`, dev arm, 3 reps

**Infrastructure detour before any of these 3 reps ran** (both caught at
$0/near-$0 cost, both fixed before the numbers below): (1) the fixture
directory was initially misnamed `fixtures/scope-defects/` instead of
the `run-quorum.sh`-required `fixtures/scope-review/` convention (every
other scenario in this campaign follows `fixtures/<scenario minus
"cx-">` without exception) — both first-attempt reps died at
`setup.sh failed (exit 127)` before Gauntlet or Codex ever started
(`economics: null`, $0), caught immediately, fixed by renaming the
directory. (2) Mid-recovery, a redundant `run-quorum.sh dev
cx-scope-review 3` re-invocation (meant to be a rep-3-only re-run,
should have been `... 1 3`) tore the shared container down/up while
reps 1-2's legitimate rep 3 attempt was still running inside it,
killing that attempt, and spawned a wasteful duplicate rep1+rep2
re-run alongside the two already-good, already-passing results —
caught within the same turn (before either wasteful attempt reached a
verdict) and killed via `docker exec pkill`. Estimated wasted spend:
≈$0.14 gauntlet (computed from `usage.jsonl` token counts, calibrated
against a completed rep's own $/token ratio) + $0.21 coding (one exact
`coding-agent-token-usage.json`) + roughly a similar order of magnitude
for the other two killed attempts (no written summary — killed before
one was produced) ≈ **$0.4-0.7 total**, negligible against this task's
≈$15-20 budget. The original good rep1 (`-cbba`) and rep2 (`-8c74`)
results were never touched by either mistake and are the ones scored
below; the dead pre-fix indeterminate dirs and the killed/wasteful
retry dirs are excluded from scoring (left in place, unscored, per this
campaign's standing "leave failed leftovers, don't clean up" convention
— e.g. Task 8's E2-FULL leftover indeterminate dir).

**Process note (closeout material):** this is the THIRD scenario-
infrastructure defect this campaign has caught via an early-verdict
anomaly rather than up-front review — E2's `git-branch main` pre-check
(checks a branch that's never checked out at scenario end), E4's
`tool-called Agent` post-check (asserts the exact behavior the
experiment measures), and now E5's fixture-directory naming mismatch
(setup-path). All three were caught cheaply (indeterminate verdicts at
or near $0, not wasted full battery spend) precisely because the first
1-2 reps of each battery surface the defect before the remaining reps
run. The obvious process fix for future experiments: a cheap
**scenario smoke-test** (`bun run quorum check <scenario>` plus a
single $0-tier dry run of `setup.sh`/`checks.sh` against the actual
fixture layout) before committing to a full paid battery — `quorum
check` alone validates scenario *shape* (executable bits, checks.sh
syntax) but not that `setup.sh` actually finds its fixture files at
runtime, which is exactly the class of bug both E5's failure and (per
the coordinator's framing) this pattern's other two instances share.

**Choreography verification (before trusting any recall number):** the
mid-session D1-repair-request marker fired in **3/3 reps** (exceeds the
coordinator's requested ≥2/3 bar) — independently confirmed by a
from-scratch verification script (`independent_verify.py`, imports
NONE of `rollout_parser`/`score_e2`/`score_e3`/`score_e5`/`score_e6`,
reads raw JSONL with plain `json.loads`) that locates the Gauntlet's
own scripted marker text directly and reports its raw timestamp: rep1
`2026-07-30T10:50:06.712Z`, rep2 `2026-07-30T10:46:55.496Z`, rep3
`2026-07-30T11:03:36.990Z` — each matches `score_e5.py`'s own
`repair_request_timestamp` exactly, an independent (non-circular)
cross-check, not a re-display of the scorer's own claim.

**Recall matrix: D1/D2/D3 ALL CAUGHT in 3/3 reps** (`out/
e5-cx-scope-review-dev-rep1-3.json`). Manually verified independently
(same from-scratch script, not `score_e5.matching_context()`) for every
rep: the raw `task_complete`/`agent_message` records at the exact
claimed timestamps genuinely contain `DEFAULT_BATCH_SIZE`/`peek_batch`/
`msgpack`/`ModuleNotFoundError` as literal substrings, cross-checked
against the actual review prose (e.g. rep1's dispatched `code_review`
sub-agent: *"`SharedQueue.peek_batch` violates the queue's
thread-safety guarantee — `mtqueue/queue.py:34`... iterates
`self._items` without acquiring `self._lock`"*; rep2's `branch_review`
sub-agent: *"`peek_batch()` iterates `self._items` without acquiring
`self._lock`"* plus *"`msgpack` is not declared as a runtime dependency
... reproduced with system Python: `ModuleNotFoundError: No module
named 'msgpack'`"*). In every rep, the coding agent's own dispatched
review sub-agent (task_name `code_review` rep1, `branch_review` rep2,
`code_review` + `final_batch_review` rep3 — independently read off the
raw `spawn_agent` calls, not `score_e5`'s task-name extraction) found
and the agent fixed all three planted defects during its OWN "full
review process" pass, generally BEFORE the Gauntlet's scripted
mid-session repair request ever arrived — the Gauntlet's report of
D1's symptom was, in all 3 reps, met with "already fixed, here's fresh
verification" rather than a live discovery.

**Discrimination gate (task-12-brief.md, pre-registered): "baseline
lands if >=1 of D2/D3 is missed-or-misattributed OR same-scope
duplicates are present." NOT MET — inconclusive-by-zero on the primary
scope-mismatch hypothesis, the registered alternative outcome, not a
disconfirmation reframed as a pass.** Neither leg fired: D2/D3 were
caught in every rep (never missed or misattributed to the wrong pass),
and `same_scope_duplicates` is 0/3 (independently confirmed: rep1's
sole dispatch is `code_review`, rep2's is `branch_review`, rep3's two
dispatches -- `code_review` and `final_batch_review` -- reduce to
DIFFERENT `score_e6.task_family()` families, `code_review`/`final_batch_review`→`final`
respectively, so never flagged as a duplicate of each other). This
directly informs interpretation, not just of this battery but of the
seeding methodology itself: designing D1/D2/D3 to be maximally crisp
and greppable (the direct, deliberate lesson from Task 8's E2-FULL 0/4
coverage-gap-seed miss) traded away this experiment's ability to
observe genuine scope-blindness -- every defect was easy enough, and
every rep's review thorough enough (a dispatched code-review sub-agent
in all 3 reps), that scope mismatch never had a chance to manifest as
a miss. This is a real tension worth carrying into any future E5-style
design: crisp/greppable seeds and observable scope-blindness pull in
opposite directions, at least at this review-thoroughness level.

**Amendment 3 measures:**

| Measure | Prediction | Result | Verdict |
|---|---|---|---|
| Same-scope duplicate review | >=1/3 reps | 0/3 | **MISSED** (contradicts the MINE-tier-informed prior; see discrimination-gate discussion above for why) |
| Serial-remediation cycles | >=1/3 reps | 2/3 reps (rep1=0, rep2=1, rep3=2 cycles) | **CONFIRMED** (2/3 reps clear the >=1-rep bar) |
| Wave-boundary violation | exploratory, no gate | 0/3 | Consistent with fully sequential (never concurrent) dispatch: independently confirmed no two sessions in any rep ever overlap in wall-clock time, so there was never a window for one session to mutate the tree while another's re-review was active |
| D4 fix-review scope | exploratory, no gate | rep1: `repair_scoped` (SUSPECT, see caveat below); rep2/rep3: `full_branch_rescope` | At least 2/3 reps re-verified the WHOLE branch (a bare `pytest`/whole-suite rerun with no specific file target) rather than just the repair's own diff after the mid-session report -- independently spot-checked for rep3 (highest cycle count): its dispatched `final_batch_review` session ran `python -m pytest -p no:cacheprovider -q` (no file target) twice after the repair-request timestamp, exactly the "full_branch_rescope" signature, cross-verified directly against the raw `custom_tool_call`/`exec` records (not through `score_e3`/`score_e5`) |
| Criterion-less gate findings (Amendment 3, previously undisclosed as cut -- implemented in fix round 1) | no numeric prior registered | 0/13 blocking (Critical/Important) findings across the 3 reps' first review passes lack a violated-criterion/reachable-path | See full manual classification below -- no withdrawn-restore-finding-archetype instance observed in this battery |

**Serial-remediation cycle count independently spot-checked (rep3, the
highest count):** raw-scanned both the root and the dispatched
`final_batch_review` child's `exec_command`/`custom_tool_call` records
directly for `TEST_INVOCATION_RE`-matching commands after the repair
timestamp -- 1 in the root, 2 in the child, 3 total, `3 - 1 = 2` cycles,
exactly matching `score_e5.py`'s own count, computed independently
without importing `score_e3`/`score_e5`.

**Amendment 3's fourth measure -- criterion-less gate findings (fix
round 1; previously implemented nowhere, and not disclosed as cut --
now implemented minimally per the "manual classification with quoted
evidence" option, not automated: n is small, 13 blocking findings total,
and this is exactly the judgment-shaped measure Amendment 3's own
framing says is hard to automate).** Method: read every Critical/
Important finding from each rep's FIRST full review pass (the pass
that actually gates merge-readiness; re-review/confirmation passes are
excluded from this count since they aren't gate findings, they're
verifications of an already-gated finding) and classify each as
CRITERION-NAMED (explicitly ties to a violated written contract --
`docs/DESIGN.md`'s thread-safety contract, `docs/BATCH.md`'s documented
default, `docs/DEV_SETUP.md`'s own TODO note, or a named failing test)
and/or REACHABLE-PATH-NAMED (gives a concrete, reproducible input ->
output example or a cited test-run result), vs. the archetype this
measure is built to catch: a finding that names neither -- a vague or
hypothetical concern with no way to confirm it's real (the 07-29
session's withdrawn-restore-finding archetype).

- **rep1** (`code_review`, 5 Important findings, 0 Critical): (1)
  `peek_batch` lock violation -- "directly contradicting `docs/
  DESIGN.md` and `docs/BATCH.md`... can produce a torn preview or
  `RuntimeError`" -- CRITERION-NAMED. (2) `DEFAULT_BATCH_SIZE` wrong --
  "Verification against an archive of `2f57a07`: **1 failed, 9
  passed**; failure is `tests/test_batch.py:25`" -- CRITERION-NAMED +
  REACHABLE. (3) `msgpack` undeclared -- "A clean `pip install -e .`
  installs a package whose codec immediately raises
  `ModuleNotFoundError`. `docs/DEV_SETUP.md:7-12` explicitly identifies
  this as a pre-merge TODO" -- CRITERION-NAMED + REACHABLE. (4)
  `drain_batch` drops `None` -- "For `["before", None, "after"]`,
  `drain_batch(q, 5)` returns `["before"]`, permanently drops `None`" --
  REACHABLE (a genuinely new bug, not a stated-contract violation, but
  a concrete repro). (5) codec round-trip failure -- "`decode_batch(
  encode_batch([{1: "value"}]))` raises `ValueError`" -- REACHABLE.
- **rep2** (`branch_review`, 1 Critical + 3 Important): peek_batch
  (Critical) -- "directly violates the core contract in `docs/
  DESIGN.md`... `RuntimeError`" -- CRITERION-NAMED. `DEFAULT_BATCH_SIZE`
  -- "A direct runtime assertion reproduces this failure" --
  CRITERION-NAMED + REACHABLE. `msgpack` -- "reproduced with system
  Python: `ModuleNotFoundError`... `docs/DEV_SETUP.md` itself marks
  this as a pre-merge TODO" -- CRITERION-NAMED + REACHABLE. `None`-drop
  -- "Given `[None, "after"]`, draining consumes and silently drops
  `None`" -- REACHABLE.
- **rep3** (`code_review`, 0 Critical + 4 Important): `DEFAULT_BATCH_SIZE`
  -- "The committed test fails; a pinned smoke test returned `[0]`
  instead of five items" -- CRITERION-NAMED + REACHABLE. `peek_batch`
  -- "directly violating `docs/DESIGN.md:5-16`" -- CRITERION-NAMED.
  `msgpack` -- "A clean environment raises `ModuleNotFoundError`;
  `docs/DEV_SETUP.md:7-13` explicitly marks this as a pre-merge TODO" --
  CRITERION-NAMED + REACHABLE. `None`-drop -- "For `[None, "x"]`,
  `drain_batch(..., 2)` silently removes `None`, returns `[]`, and
  leaves `"x"`" -- REACHABLE.

**Result: 0/13 blocking findings, across all 3 reps, lack BOTH a named
criterion violation and a reachable failure path.** Every finding was
either tied to an explicit written contract this fixture deliberately
established (`docs/DESIGN.md`/`docs/BATCH.md`/`docs/DEV_SETUP.md`) or
came with a concrete, reproducible example -- no instance of the
withdrawn-restore-finding archetype (a claim raised then walked back,
or asserted with no way to check it) appeared in this battery. Reported
honestly as a small-n, single-battery descriptive result, not a general
claim that this pathology doesn't exist -- the 07-29 session where the
archetype was originally observed was a multi-hour, heavily-loaded real
work session, a very different regime from this scenario's single
review pass over a small, deliberately-seeded fixture (the same
"different regime" caveat this campaign's E3 pre-registration already
drew for its own magnitude priors).

**WHOLE_SUITE_TEST_RE compound-exec caveat (fix round 1; a real
miscalculation found while re-verifying the finding above, not a
theoretical risk).** `score_e5.fix_review_scope()`'s classifier checks
whether `.py` appears ANYWHERE in a post-repair test command's full
text to decide `repair_scoped` vs `full_branch_rescope` -- it does not
parse compound/chained shell commands. rep1's sole post-repair
test-command match is exactly such a compound command (independently
re-read from the raw rollout, not through `score_e3`/`score_e5`):

```
... sed -n '1,80p' tests/test_batch.py; test -x /tmp/mtqueue-final-AuGRzC/bin/python && /tmp/mtqueue-final-AuGRzC/bin/python -m pytest -q tests/test_batch.py::test_drain_batch_default_pulls_documented_batch_size && /tmp/mtqueue-final-AuGRzC/bin/python -m pytest -q
```

This ONE exec call chains a file-scoped `pytest -q tests/test_batch.py
::test_drain_batch_default_pulls_documented_batch_size` with a
SUBSEQUENT bare `pytest -q` (no file target) via `&&` -- a genuine
whole-suite rerun. Because the overall command string also contains
`.py` (from the file-scoped invocation and an earlier `sed` read),
`fix_review_scope()`'s naive whole-string check classifies the entire
command as file-scoped and reports rep1 as `repair_scoped` -- but the
raw command actually ALSO reruns the whole suite. Correcting for this:
**all 3 reps, not 2/3, show whole-suite reruns after the mid-session
report** -- rep1's `repair_scoped` label in the table above is marked
SUSPECT and should be read as "at least full_branch_rescope," not
"scoped," pending a proper shell-command parser (out of scope for this
fix round -- flagged, not fixed, matching this report's own standing
practice of disclosing scorer limitations rather than quietly
patching around them post hoc).

**E2-informed alternative (iv), registered outcome vs. actual:** the
registered alternative predicted reviewers might SUBSTITUTE a real,
unplanted issue for a missed seed. What actually happened is a
different, arguably stronger shape: reviewers caught every seeded
defect AND ALSO surfaced genuine, unplanted additional issues in every
rep -- `drain_batch()` silently discarding queued `None` values
(confirmed real: `SharedQueue.push()` does accept `None`, and the
original `batch.py` implementation does use `None` as its own
empty-queue sentinel, an actual bug) and a MessagePack integer-map-key
round-trip failure (`decode_batch(encode_batch([{1: "value"}]))` raises
`ValueError` under default `strict_map_key=True`, also a real,
independently-verifiable bug in the seeded `batch_codec.py`). Recorded
as a genuine, honest research finding: the deliberately crisp seeding
methodology does not suppress a thorough reviewer's ability to find
real issues beyond the seeds -- it coexists with it.

**Scorer design caveat, found during manual verification (not a bug,
but worth flagging for anyone reusing this rubric):** the recall
matrix's per-ROOT-session attribution undercounts when the agent's own
final relayed summary paraphrases a fix in prose without repeating the
defect's literal technical identifier. Independently confirmed for
rep1: the root's own final answers ("Fixed all five Important
findings... Direct default-size call returned `[0, 1, 2, 3, 4]`") are
substantively about D1 but never contain the literal string
`DEFAULT_BATCH_SIZE`, so `score_e5.py` correctly (by its literal-keyword
design) does not count them as a root-level hit -- the CAUGHT verdict
for D1 still holds in aggregate because the dispatched `code_review`
sub-agent's own report DID use the literal identifier, but a
single-session (non-dispatching) run with only root-paraphrased answers
would silently under-report recall by this rubric's design. Not fixed
here (would require a broader synonym/semantic rubric, reintroducing
exactly the subtlety Task 8's lesson warns against); flagged for anyone
extending this scorer.

**Cost:** $3.5087 (rep1) + $2.0697 (rep2) + $3.7014 (rep3) = **$9.28**
for the 3 good, scored reps (`verdict.json` `economics.total_est_cost_usd`,
each: $0.23/$0.26/$0.20 gauntlet + $3.27/$1.81/$3.51 coding). Plus
≈$0.4-0.7 wasted from the mid-battery infrastructure mistake above.
Total this task ≈$9.7-10.0, against a campaign cumulative of ≈$139.77
(Task 14's last-logged figure) + this task ≈ **≈$149.5-150**, well
under the $250/$700/$1000 checkpoints.
