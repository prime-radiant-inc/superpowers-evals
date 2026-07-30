# E2 FULL branch-review baseline: inconclusive-by-zero (Task 8)

**Status: TERMINAL — inconclusive-by-zero, exactly as pre-registered as a
live possibility before this battery ran.** 4/4 dev-arm reps show the root
controller dispatching exactly one reviewer subagent (the expected,
intended shape); zero of those four reviewers themselves spawned any
further descendant. The registered prediction (`>=1 reviewer descendant
in >=half of reps`) cannot be confirmed or refuted — the rig never
produced a single instance of the phenomenon it measures. Per the
pre-registration and the discrimination rule, no further reps were run;
E2's baseline question is folded into E6 (long-history/compaction
elicitation), the same terminal state as E1's axis B.

Pre-registration: `logs/2026-07-28-codex-efficiency.md`, "E2-FULL
PRE-REGISTRATION" entry. Result entry: same file, "E2-FULL RESULT"
entry (both reproduced/expanded here).

## What was built

- **Scenario:** `campaigns/codex-efficiency/scenarios/cx-branch-review/`
  (`story.md` / `setup.sh` executable / `checks.sh` non-executable,
  `# coding-agents: codex` first line). Interactive quorum scenario
  (`quorum run ... --coding-agent codex`, NOT `codex exec` — the Task 7
  lesson: a single-turn, single-diff review never delegates, so this had
  to be a real interactive session over a real branch), `quorum_tier:
  adhoc`, `quorum_max_time: 20m`. Gauntlet brief is a neutral
  engineer-oversight persona with no efficiency/measurement vocabulary
  anywhere in the body (Task 5's blinding-fix precedent applied from the
  start, not fixed after the fact): "You are a software engineer who has
  been working on a small Python library ... on the `feature` branch.
  Implementation is done and you want a review before merging to
  `main`." Fixed typed message: *"Please do a final review of the
  feature branch using your superpowers review skills before we
  merge."* Acceptance criteria are completion-oriented (branch
  genuinely examined, a findings/assessment produced, no unrecoverable
  error) — scoring happens offline, same convention as `cx-sdd-small`.
- **Fixture:** `campaigns/codex-efficiency/fixtures/branch-review/build.sh`
  — hand-authored git history (the review's INPUT, not skill output, per
  the task brief's explicit allowance). A `main` baseline (2 files: a
  package skeleton + a stub `README.md`) plus a `feature` branch (left
  checked out) carrying 4 commits across 4 concerns:
  - core logic: `taskqueue/queue.py`, `taskqueue/validators.py`
  - CLI: `taskqueue/cli.py`, `taskqueue/__main__.py`
  - tests: `tests/test_queue.py`, `tests/test_validators.py`,
    `tests/test_cli.py`
  - docs: `docs/USAGE.md`, `docs/DESIGN.md`, `README.md` (rewritten)

  **10 files touched, 453 changed lines** (`git diff --stat main..feature`
  on the built fixture), 5 commits total (1 baseline + 4 feature) — past
  the task's "8-12 files / 300+ lines / several commits / 3+ concerns"
  target, deliberately, so a reviewer has genuine surface area to
  consider splitting the review up.
- **Two seeded issues**, both confirmed live by hand before committing,
  both invisible to the shipped test suite (`python3 -m pytest tests/`
  on the built `feature` branch: **22/22 pass**):
  1. **Missing edge-case test** — `taskqueue/queue.py:46-58`
     (`dequeue_batch(n)`) is correctly implemented for `n` greater than
     the queue's length, or on an empty queue (confirmed by hand:
     `dequeue_batch(5)` on a 1-item queue returns the 1 item;
     `dequeue_batch(3)` on an empty queue returns `[]`; neither raises),
     but `tests/test_queue.py` (lines 39-51) never exercises either
     path — only `n <= len(queue)`.
  2. **Docstring/behavior mismatch** — `taskqueue/queue.py:60-65`
     (`peek()`)'s docstring says "Returns None if the queue is empty";
     the implementation (`return self._heap[0][2]`) has no empty check
     and raises `IndexError` instead (confirmed by hand:
     `PriorityQueue().peek()` on a fresh queue raises
     `IndexError: list index out of range`). `docs/DESIGN.md` repeats
     the same wrong-relative-to-code contract, so a reviewer reading
     only the docs would be misled the same way.
- **Scorer:** `campaigns/codex-efficiency/score_e2.py` (TDD, 9 tests in
  `test_score_e2.py`, all passing). Walks every rollout in a run's
  `home/.codex/sessions/**` TRANSITIVELY via `child_links()` — not just
  the root's own spawns (unlike `score_e1.py`'s per-spawn-tuple design,
  which only needed the root's direct dispatches) — starting from the
  chronologically-earliest rollout as root, following each discovered
  session's OWN `extract_spawns()`/`child_links()` output to find
  further descendants. A reviewer that itself spawns further reviewers
  is exactly the recursion this measures, so the walk cannot stop at
  depth 1. Census per run: `total_sessions` (tree size, root included),
  `max_depth` (root = 0), `spawns_by_nonroot` (spawn_agent calls issued
  by anyone OTHER than root — the recursion signal, since root
  dispatching one reviewer is the expected/intended single delegation),
  `missing_task_complete` (tree rollouts with zero `task_complete`
  events), `total_wait_calls` / `root_wait_calls`, and
  `orphan_rollouts` (rollout files present but unlinked from the tree).
  `score_run()` asserts root identity (root's first
  `event_msg/user_message` contains the review-request marker) and
  raises `SystemExit` if that fails, rather than silently scoring the
  wrong session as root. `FORCE=1`/collision-refusal output convention
  matches `score_e1.py`/`score_e8.py`/`score_e9.py`.

## Battery run

4 reps, `dev` arm, sequential, `bash run-quorum.sh dev cx-branch-review 4`.

**Housekeeping note, zero cost:** the first invocation used a `checks.sh`
with a real bug — `git-branch main` (the `git-branch <name>` check verb
asserts the *current* branch equals `<name>`; it is not an existence
check) — which always fails here since the fixture deliberately leaves
`feature` checked out. Rep1's first attempt came back `indeterminate`
in under 1 second (`verdict.json`: `"gauntlet": null`, `"economics":
null` — no Gauntlet or Codex session ever started, $0 spent). Fixed
`checks.sh` to assert `git-branch feature` only, re-validated with `bun
run quorum check scenarios/cx-branch-review` (`ok cx-branch-review` /
`ok credentials`), then ran the real 4-rep battery. The leftover
indeterminate directory
(`results/cx-eff-cx-branch-review-dev-rep1/..-1cc4/`) was left in place
on disk, unscored, not counted in any total below.

All 4 real reps: `final: pass` (Gauntlet-Agent passed, both deterministic
post-checks passed: `tool-called Agent`, rollout file exists). Gauntlet
summaries (paraphrased by the Gauntlet-Agent watching the terminal, not
authoritative for scoring — see the census/recall sections below for
what was actually verified from rollout content) consistently describe
Codex inspecting real `git log`/`git diff`/`git show` output across
`main..feature`, reading the changed files, producing a structured
findings summary, and giving an explicit merge-readiness verdict.

## Census (score_e2.py output, all 4 reps)

| rep | root rollout | root-identity | rollout files | tree sessions | max_depth | spawns_by_nonroot | missing_task_complete | root wait_calls | total wait_calls |
|---|---|:---:|---:|---:|---:|---:|---:|---:|---:|
| 1 | `...09-50-40...2670.jsonl` | PASS | 2 | 2 | 1 | 0 | 0 | 3 | 3 |
| 2 | `...09-54-44...8680.jsonl` | PASS | 2 | 2 | 1 | 0 | 0 | 2 | 2 |
| 3 | `...09-59-48...32f2.jsonl` | PASS | 2 | 2 | 1 | 0 | 0 | 3 | 3 |
| 4 | `...10-04-10...a8f2.jsonl` | PASS | 2 | 2 | 1 | 0 | 0 | 2 | 2 |

Every rep: root dispatches exactly 1 reviewer child (`spawn_count=1` at
depth 0); the reviewer child issues 0 further spawns (`spawn_count=0` at
depth 1). No orphan rollouts in any rep (every session file present under
`home/.codex/sessions/**` resolves into the 2-node tree). Full node-level
detail and raw JSON: `campaigns/codex-efficiency/out/e2-cx-branch-review-dev-rep1-4.json`.

Root dispatch arguments (message field never read/printed, per
`extract_spawns()`'s design — `Spawn` carries no such field):

| rep | task_name | fork_turns | model |
|---|---|---|---|
| 1 | `branch_reviewer` | none | (omitted) |
| 2 | `final_branch_review` | none | (omitted) |
| 3 | `final_code_review` | none | (omitted) |
| 4 | `final_code_review` | none | (omitted) |

Not this experiment's territory (E1 owns fork hygiene), noted for
completeness: all 4 dispatches are isolated (`fork_turns:"none"`) with
`model` omitted, consistent with E1's baseline finding on this
fresh-session `dev` arm at a different scenario shape.

## Independent verification (not just trusting the scorer)

**Recursion result:** `grep -c '"name":"spawn_agent"'` run directly
against each of the 4 reviewer-child rollout files (bypassing
`extract_spawns()`/`score_e2.py` entirely) — **0 matches in all 4**.
The `spawns_by_nonroot=0` result is genuine, not a parsing artifact.

**Root-identity assertion:** `score_run()` did not raise `SystemExit` on
any of the 4 reps — the chronologically-earliest rollout's first
`event_msg/user_message` contained the review-request marker in every
case, confirmed structurally by the scorer itself (not spot-checked by
hand beyond that, since a failure here is a hard stop by design).

**CLI version:** `session_meta.cli_version` read directly off all 4 root
rollouts — `0.146.0` in every case.

**Workdir housekeeping:** no report/review-package file
(`*review*.diff` or otherwise) left in any of the 4 workdirs — findings
live only in the session transcript, matching the
`requesting-code-review` skill's "return findings directly" convention.
`.git` history and working tree otherwise untouched by the review (no
branch files changed — confirmed in 2 of the 4 root relay messages
explicitly: "No branch files were changed; the pre-existing untracked
`.agents/` directory remains untouched").

## Seeded-issue recall (secondary readout — does not gate the
discrimination verdict)

Read from each rep's **root session's `task_complete.last_agent_message`**
— specifically the FIRST `task_complete` event, the message actually
relayed to the Gauntlet as the review result (each root session emits a
second, later `task_complete` for the brief "thanks"/"you're welcome"
close-out exchange, which was not scored) — cross-checked against the
dispatched reviewer child's own `task_complete.last_agent_message` for
context. No report file existed in any workdir to also check (see
above).

- **Issue 2 (docstring/behavior mismatch, `peek()`): 4/4 (100%).** Every
  rep named `taskqueue/queue.py` line 60 or 65 exactly, described the
  `IndexError`-vs-documented-`None` contradiction precisely (citing both
  the docstring and, in 2/4 reps, `docs/DESIGN.md` explicitly), rated it
  "Important," and gave the correct fix (add an empty-queue guard, add a
  regression test).
- **Issue 1 (missing edge-case test, `dequeue_batch`): 0/4 by strict
  match — no rep's relayed review named this specific gap** (no test
  exercises `n` greater than the queue's length, or an empty queue).
  One partial, deliberately NOT counted toward the 0/4: rep1's
  *dispatched reviewer's own* transcript (not what was relayed to the
  Gauntlet) included, in a Recommendations section, "Add tests for
  `dequeue_batch(0)`, empty `peek()`, ..." — `dequeue_batch(0)` is an
  adjacent but distinct boundary (n=0 on any queue) from what was
  seeded (n greater than the queue's length, or n>0 on an empty queue),
  and it never reached the top-level summary anyway.

  **This is reported as a genuine miss, not stretched into a hit.** All
  4 reviewers instead spent their finding budget on real,
  independently-discovered issues that were never seeded:
  - unvalidated/malformed JSON input in `cli.py`'s `_load()` producing
    raw Python tracebacks instead of a clean CLI error (reps 1, 3, 4)
  - non-atomic JSON persistence in `cli.py`'s `_save()` — a crash
    mid-write can corrupt the sole store file (all 4 reps, rated
    Important in 1/4, Minor in 3/4)
  - `dequeue_batch(True)` silently treated as `dequeue_batch(1)` because
    Python's `bool` is an `int` subclass, so the existing `n < 0` guard
    never rejects it (rep 2 only — a genuine, real bug not planted by
    this fixture)
  - missing packaging metadata for the README's `pip install -e .`
    instruction, which the README itself admits doesn't work (all 4
    reps, rated Minor)

  These are substantive, correct, file:line-cited findings — the miss on
  Issue 1 reflects 4 independent reviewers converging on different real
  gaps than the one this fixture specifically planted, not low-effort or
  perfunctory reviews. Every rep gave an explicit "not ready to merge" /
  "merge after fixes" verdict, none said "looks good" without
  substantiation.

## Discrimination gate

**Registered operational definition** (pre-registration, since "a
dispatched branch reviewer produces >=1 descendant" needed a precise
census-field mapping before scoring): a reviewer descendant means
`spawns_by_nonroot > 0` (equivalently `max_depth >= 2`) — a session
below the root itself spawning something further. The root's own single
expected reviewer dispatch does NOT by itself count; that is the
intended baseline shape, not the pathology.

| Clause | Threshold | Observed | Holds? |
|---|---|---:|:---:|
| reviewer descendant (`spawns_by_nonroot>0`) in >=half of reps | >=2/4 | 0/4 | **NO** |

**Per the pre-registration's explicitly-registered alternative outcome:
this is INCONCLUSIVE-BY-ZERO, not a "pathology absent, treatment
unnecessary" pass.** The registered prediction cannot be evaluated as
confirmed or refuted in either direction, because the phenomenon it
measures never occurred even once to have its rate estimated. Per the
task instruction, no additional reps were run chasing this shape.

**Disposition:** E2's baseline question (does review recursion happen at
all, absent intervention) is folded into E6's scope
(long-history/compaction elicitation) — the same terminal state E1's
axis B reached (Task 6) and the same shape E2-MICRO (Task 7) found at
single-turn scale. Three independent rig shapes now point the same
direction: fresh, short-lived Codex sessions (a single-turn diff review,
a 3-4 task SDD plan, and now a genuine multi-file interactive branch
review) do not spontaneously recurse or fork without an
already-accumulated long history. The corpus's own Finding 1/Finding 2
narratives describe long-running, heavily-loaded controller sessions —
E6's scenario (long controller session, forced compaction, post-compaction
dispatch) is the condition the evidence actually supports for eliciting
this family of pathologies.

## Cost

| rep | Gauntlet | Coding | total |
|---|---:|---:|---:|
| 1 | $0.15 | $0.84 | $0.99 |
| 2 | $0.16 | $0.79 | $0.96 |
| 3 | $0.12 | $0.81 | $0.92 |
| 4 | $0.18 | $0.96 | $1.14 |
| **Total** | **$0.61** | **$3.40** | **$4.01** |

Materially cheaper per rep than E1's SDD batteries (~$5/rep) — a
single-turn interactive review has far less work to do than executing a
3-task plan. Subscription `used_percent` (`rate_limits.primary.used_percent`,
last `token_count` event of the root rollout): **8.0%** (rep1, first run)
-> **9.0%** (rep4, last run), +1.0 point. Ledger row appended to
`logs/2026-07-28-codex-efficiency.md`.

## Deviations from the brief

1. **`checks.sh` bug found and fixed mid-task** (see Housekeeping note
   above) — `git-branch main` was never valid for this fixture's
   design (feature branch left checked out); cost $0, caught before any
   real spend.
2. **Battery scope: 4 reps only, `dev` arm only**, per the brief's own
   Step 4 discrimination gate ("if baseline never delegates [past the
   root's own dispatch], record inconclusive-by-zero and stop E2") and
   the task instruction's explicit "do NOT run more reps chasing the
   pathology." No treatment arm exists for E2 in DESIGN.md's tier plan
   (MINE -> MICRO -> FULL baseline, no treatment tier registered), so
   none was attempted.
3. **Seeded-issue recall scored by hand** (reading
   `task_complete.last_agent_message` directly), not via a new automated
   regex-matching function in `score_e2.py` — the task instructions
   described this as a read-and-report step ("read the final
   task_complete.last_agent_message ... "), not a scorer interface
   requirement (unlike the brief's own `score_e2.py` interfaces section,
   which lists only the census fields). Kept as manual analysis,
   consistent with the task-8-brief's scorer interface scope.

## Tests / verification

- `python3 test_score_e2.py`: 9/9 pass (TDD, written before the real
  battery ran — covers root-identity pass/fail, isolated 2-child tree,
  depth-2 recursion counting, orphan-rollout detection,
  missing-task_complete detection, wait_calls summation, and the
  output-label/FORCE-guard convention).
- Existing suites unaffected: `test_rollout_parser.py` 10/10,
  `test_score_e1.py` 6/6, `test_score_e9.py` 7/7 — all still pass.
- `python3 -m pytest tests/` on the built fixture's `feature` branch:
  22/22 pass (verified before committing the fixture, and again
  independently during pre-registration).
- No `evals/results` content committed (`git status` checked before
  every `git add`); `campaigns/codex-efficiency/out/e2-report.md` and
  `out/e2-cx-branch-review-dev-rep1-4.json` force-added past the repo's
  blanket `out*/` `.gitignore` rule, matching E1/E7/E8/E9/E2-micro's
  established precedent.
- No client content: this battery's corpus is entirely our own
  synthetic fixture and our own quorum runs — no external/Drew corpus
  involved in this task.

## Concerns

1. **E2's core question remains genuinely open.** This is the third
   independent rig shape (after E1's baseline and E2-MICRO) to find zero
   recursion/forking in a fresh, short-lived Codex session — a
   consistent pattern, but still not a positive demonstration that E6's
   long-history condition actually elicits the pathology either; that is
   untested until E6 runs.
2. **Seeded-issue recall's Issue 1 (missing edge-case test) may simply
   be a weak probe for "does the reviewer notice test-coverage gaps" —**
   the reviewers clearly DO notice coverage/robustness gaps in general
   (the malformed-JSON and non-atomic-write findings are exactly that
   category), they just didn't converge on this specific one. A future
   experiment using coverage-gap seeding as its actual manipulation
   should probably not reuse this exact edge case.
3. **n=4 is small** for a "zero incidence" claim in the strict
   statistical sense, though the inconclusive-by-zero framing (not "we
   proved the rate is 0%") is exactly what the pre-registration commits
   to reporting regardless of n, and matches the campaign's established
   handling of the same shape in E1/E2-MICRO.
4. **The leftover indeterminate rep1 directory** from the checks.sh bug
   (`results/cx-eff-cx-branch-review-dev-rep1/..-1cc4/`) was not cleaned
   up (no destructive `rm -rf` without explicit authorization) — it sits
   alongside the real, scored rep1 run but contains no rollout files and
   was never passed to `score_e2.py`, so it cannot contaminate any
   result in this report.
