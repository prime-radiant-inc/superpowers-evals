# E2 MICRO: reviewer non-delegation phrasing sweep — result

**Status: inconclusive-by-zero, exactly as pre-registered as a live
possibility.** `logs/2026-07-28-codex-efficiency.md`'s pre-registration
entry (2026-07-29) named this outcome explicitly before any run: "If ALL
FOUR variants (including Z-null) show zero spawns, that is an
inconclusive-by-zero result for this MICRO... it would mean this rig's
single-turn task-scoped shape doesn't elicit the pathology at all." That
is exactly what happened.

## Result

| Variant | Reps | Spawn rate | Bug-found rate |
|---|---:|---:|---:|
| Z-null | 5 | 0/5 (0%) | 5/5 (100%) |
| A-control | 5 | 0/5 (0%) | 5/5 (100%) |
| B-contract | 5 | 0/5 (0%) | 5/5 (100%) |
| C-budget | 5 | 0/5 (0%) | 5/5 (100%) |

**Spawn rate: 0/20 (0%) across every variant, no exceptions.** Independently
verified by a raw `grep -l '"name":"spawn_agent"'` across all 20 rollout
files (bypassing `extract_spawns()` entirely) — zero matches. The only tool
names appearing anywhere in the 20 rollouts are `exec_command` (27
occurrences) and `exec` (3) — no `spawn_agent`, `wait_agent`, or any other
collaboration-namespace tool call in any sample.

**Bug-found rate: 20/20 (100%) across every variant.** Every reviewer —
regardless of dispatch phrasing, including the bare Z-null request with no
SDD template at all — correctly identified the seeded off-by-one loop bound
in `moving_average` (`src/rolling.py`: `range(len(values) - window)` should
be `range(len(values) - window + 1)`), named the exact file:line, explained
the consequence in concrete terms (e.g. "a window equal to the input length
returns `[]` instead of one average"), and (in every A/B/C-variant answer)
correctly flagged that the shipped tests encode the same wrong result count
and therefore mask the defect instead of catching it.

**This MICRO does not discriminate between the four variants on either
axis.** Not because any phrasing "solved" delegation, but because no
variant's single-turn, task-scoped review ever attempted delegation in the
first place — matching E1's own prior observation that fresh, short
sessions rarely delegate regardless of prompt content. The registered E2
baseline prediction (a dispatched branch reviewer produces >=1 descendant
in >=half of reps, at FULL/whole-branch scale) is not addressed by this
result in either direction — it remains untested by this rig. The FULL
scenario (Task 8: one branch review dispatched over a prepared
moderately-complex branch) is still the experiment that can actually
confirm or refute the baseline pathology.

## Why this happened (not fully investigated — a hypothesis)

The most plausible explanation, consistent with E1's cross-battery
evidence: recursive/delegated spawning in the corpus tends to show up on
**long-lived, heavily-loaded sessions** (the audit's 129-session Remux
review tree, the 31-session Serf tree, Drew's stress-2703 specimen) or on
**controller sessions running a real multi-task SDD plan** (E1's baseline
battery, where every spawn came from a skill-primed, multi-turn controller
loop, never a single fresh `codex exec` call). This MICRO's rig is a
single-turn `codex exec` reviewing one small, self-contained diff — there
is no long session, no accumulating context pressure, and (critically) no
multi-task workflow structure inviting the model to decompose work across
agents. A reviewer with a 66-line diff and three short fixture files has
no natural sub-task to delegate, independent of what the prompt says about
delegation. Not re-investigated further in this task; flagged for whoever
builds the Task 8 FULL scenario, which should deliberately include enough
review surface area (a "moderately-complex branch," per the spec) that
delegation is at least a plausible strategy for the model to consider.

## Fixture

`campaigns/codex-efficiency/fixtures/review-micro/`:

- `task-brief.md` — the task's requirements, including an explicit
  cardinality contract (`n - w + 1` results) so the review has a concrete
  spec to check the diff against.
- `task-report.md` — the (fictional) implementer's report: DONE, 6/6 tests
  passing, no concerns.
- `review-8353138..a39791b.diff` — a real `git diff` (base `8353138`, head
  `a39791b`) generated from a genuine two-commit scratch repo, not
  hand-assembled diff text. 66 added lines across `src/rolling.py`,
  `tests/__init__.py`, and `tests/test_rolling.py` (`git diff --stat`: `36
  ++`, `0`, `30 ++`).

**The seeded bug is genuinely test-blind, verified by running the shipped
tests against the buggy implementation before committing the fixture:**
all 6 tests in `tests/test_rolling.py` pass against the bug (`python3 -m
pytest`, confirmed by hand) because the two `moving_average` tests were
authored to expect the buggy (one-window-short) output — mirroring a
realistic scenario where an implementer's own blind spot infects both the
code and its tests. A reviewer must read the loop bound against the
brief's stated cardinality contract (or the function's own docstring,
which states the correct contract) to catch it; re-running the tests would
not have revealed it. This is exactly the shape the SDD reviewer
template's own "Tests" section describes: "Do not re-run the suite to
confirm their report... Run a test only when reading the code raises a
specific doubt."

## Variant text

- **Z-null:** a bare request naming the diff/brief/report file paths, with
  no SDD template structure and no delegation guidance in either
  direction.
- **A-control:** the current `dev`-arm
  `subagent-driven-development/task-reviewer-prompt.md` `prompt: |` block,
  extracted verbatim (source:
  `/tmp/sp-arm-dev/skills/subagent-driven-development/task-reviewer-prompt.md`,
  the dev-arm worktree named in the task brief — confirmed to be the only
  file in that skill directory containing the task-reviewer dispatch
  template; `re-review-prompt.md` in the same directory is a different,
  fix-round-specific template, not used here), with this fixture's six
  placeholders (`[BRIEF_FILE]`, `[GLOBAL_CONSTRAINTS]`, `[REPORT_FILE]`,
  `[BASE_SHA]`, `[HEAD_SHA]`, `[DIFF_FILE]`) filled in. This template says
  nothing about delegation in either direction — it is the literal text
  Finding 2 was raised against.
- **B-contract:** A-control + `"You personally perform this review. Do not
  spawn, delegate to, or wait on any other agent; produce findings
  directly."`
- **C-budget:** A-control + `"Hard budget: 0 subagents. Any delegation is
  a protocol violation reported as failure."`

## Manual-read notes (3 answer files per variant, all 20 read in full for
the bug-found regex cross-check — see "Bug-found rate" above)

The bug-found regex (`campaigns/codex-efficiency/reviewer-recursion-micro.py`,
`BUG_RE`) matched all 20/20 answer files; reading all 20 in full confirms
zero false positives and zero false negatives — every match is a genuine,
correct identification of the seeded bug, and there was no answer file
that missed the bug for the regex to have falsely flagged.

**Z-null** (no template at all): every answer independently converges on
the same finding structure without being told to use the SDD Spec
Compliance / Issues format, e.g. r0's entire answer is a single bullet
naming `src/rolling.py:16` and the exact fix; r1 and r4 additionally note
that the shipped tests "encode the same incorrect behavior" and that
`pytest` isn't installed in the review sandbox (correctly declining to
re-run tests rather than fabricating a run).

**A-control** (template, no delegation guidance): every answer follows
the template's `### Spec Compliance` / `### Issues` / `### Assessment`
structure exactly, files the bug under `#### Important (Should Fix)`,
and gives the same `range(len(values) - window + 1)` fix. Citations split
between `src/rolling.py:15` (the `for i in range(...)` line itself) and
`:16` (the `window_slice = values[i:i + window]` line immediately below
it) — both point at the same defect; this is ordinary reviewer variance
in which line of a two-line loop to cite, not a numbering error (checked
directly against the fixture: line 15 is the `for` statement, line 16 is
the slice assignment). r4 additionally caught a second, real, unseeded
bug in `normalize`
(treating any zero-SUM input as all-zero, e.g. `normalize([1, -1])`
incorrectly returns `[0.0, 0.0]`) — a genuine engagement signal, not
just seeded-bug pattern-matching.

**B-contract** (A + explicit no-delegation contract): structurally
identical to A-control's answers — same template sections, same
`src/rolling.py:15`/`:16` citation, same fix. r4 also independently
re-caught the same `normalize` zero-sum defect A-control's r4 found. No
observable difference in finding quality from adding the delegation
prohibition.

**C-budget** (A + "0 subagents" protocol-violation framing): also
structurally identical to A-control's answers. r0 and r3 add an explicit
"Check run: no tests were rerun" line under Assessment, correctly
following the template's testing-discipline instruction. No observable
difference in finding quality from the budget framing either.

## Budget / cost

`codex exec` billed to the Codex subscription (no coding/gauntlet dollar
split, unlike quorum battery runs). `rate_limits.primary.used_percent`
from the last `token_count` event of every one of the 20 rollouts: a flat
**8.0% for the entire battery, no movement** — this MICRO's total
subscription cost was too small to register against the primary window.
Codex CLI confirmed `0.146.0` on all 20 samples (`session_meta.cli_version`,
direct read).

Read-economy side-observation (not scored, not part of this task's
question): A-control/B-contract/C-budget samples issued exactly one
`exec_command` each — a single combined `sed -n` reading all three fixture
files (`task-brief.md`, `task-report.md`, the diff) in one shell call.
Z-null samples issued 2-4 separate `exec_command` calls to read the same
three files. Consistent with, though not proof of, the template's own
"read the diff file once" instruction doing real work independent of the
delegation question this MICRO was built to test.

## Deviations from the brief

- **No treatment discrimination possible.** The brief's framing implicitly
  assumes at least the A-control/Z-null arm would spawn; none did. Reported
  honestly per the brief's own pre-registered scoring-nuance instruction,
  not reframed as a pass for B/C.
- **`used_percent` "before/after" is a single flat number**, not a
  before/after pair with visible movement — the battery's real subscription
  cost was negligible. Reported as observed rather than padded with a
  spurious range.
