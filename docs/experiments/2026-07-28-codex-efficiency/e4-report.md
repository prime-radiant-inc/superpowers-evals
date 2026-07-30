# E4 proportional-ceremony census (Task 11)

**Status: DONE. Primary discrimination gate (spike vs. arch) is
inconclusive-by-zero — for a structural reason more specific than either
pre-registered explanation: 3/3 spike reps never produce a tracked-file
patch at all, so "ceremony before first code" has no anchor to measure
against on this task class.** Bounded and arch, where the gate *is*
computable, show ceremony that scales somewhat with task complexity (not
flat) but with an identical planning-artifact shape (2 docs before code in
every rep, design-then-plan). Full detail below.

Pre-registration: `logs/2026-07-28-codex-efficiency.md`, "E4
PRE-REGISTRATION" entry (2026-07-29), extending the original E4 baseline
entry from Task 1 (2026-07-28).

## What was built

- **Scenarios** (`campaigns/codex-efficiency/scenarios/cx-ceremony-{spike,bounded,arch}/`):
  three task classes sharing one fixture
  (`campaigns/codex-efficiency/fixtures/ceremony/` — a hand-authored,
  stdlib-only Python HTTP JSON "notes" service, `http.server`, in-memory
  store, GET/POST/DELETE on `/notes`, 11/11 `unittest` tests passing,
  verified before committing). `fixtures/ceremony-{spike,bounded,arch}`
  are relative symlinks to the shared `fixtures/ceremony/` directory —
  `run-quorum.sh`'s existing fixture-sync convention derives a fixture
  directory name from the scenario name minus its `cx-` prefix (e.g.
  `cx-ceremony-spike` → `fixtures/ceremony-spike`), which doesn't match a
  single shared directory by itself; verified directly that `rsync -a`
  follows a trailing-slash symlink source and bash's `[[ -d ... ]]`
  follows symlinks too, so `run-quorum.sh` needed no change (deliberately
  not touched — a live shared script another lane may be using
  concurrently).

  Gauntlet briefs use the task brief's exact texts verbatim, plain persona
  opening, no scoring/measurement vocabulary anywhere in the body (Task
  5's blinding-fix precedent applied from the start):
  - **spike:** *"Can we detect whether the service's port is already in
    use before binding? Not sure it's possible portably — find out, quick
    and dirty is fine."*
  - **bounded:** *"Add a --quiet flag that suppresses request logging.
    The logging call sites are in server.py."*
  - **arch:** *"We need to split the service into a reusable library +
    thin CLI so another team can embed it."*

  Gauntlet persona: cooperative, terse, minimal-reasonable-default answers
  to clarifying questions, never volunteers a process preference.

- **`score_e4.py`** (TDD, 19 tests in `test_score_e4.py`, all passing;
  existing suites unaffected — `test_rollout_parser.py` 15/15 [10
  original + 5 new `patch_applies()` tests], `test_score_e1.py` 6/6,
  `test_score_e2.py` 9/9, `test_score_e9.py` 7/7). Walks a run's full
  session tree (root + descendants via `child_links()`, `score_e2.py`'s
  same transitive convention) and merges every `patch_apply_end` event
  (new `rollout_parser.patch_applies()` helper) across the whole tree into
  one chronological view. **First non-doc patch (T)** = the earliest
  `success:true` patch whose changed paths include at least one path
  that's neither under a `docs/` directory nor a `*.md` file. Census
  against T: user turns in the ROOT rollout only (before T), distinct doc
  paths written before T (or, if T never occurs, across the whole
  session), tree-wide tool calls before T, and wall-clock from the root's
  first record to T.

  Every field independently hand-verified against raw rollout JSON before
  trusting the scorer (see Manual inspection below) — not just reproduced
  by construction.

- **`ceremony-path-micro.py`** (Anthropic Messages API, `claude-opus-4-8`,
  REPS=5, 45 calls, run to completion before the FULL battery). Three
  variants of an entry-decision system-prompt paragraph — Z-null (no
  guidance), A-current (verbatim `<HARD-GATE>` block from
  `/tmp/sp-arm-dev/skills/brainstorming/SKILL.md` lines 12-14), B-three-path
  (a router paragraph drafted for this task, distinguishing spike/bounded/
  architectural ceremony explicitly) — each put to the model against all
  three task briefs, forced to a one-word SPIKE/BOUNDED/FULL answer.
  Treatment-phrasing pre-work only, per the task brief; no skill edits
  land in this campaign.

## Outage triage (mid-battery Anthropic incident)

Two of the original nine battery runs (arch rep1, rep2) coincided with a
live Anthropic API outage. Every rep's Gauntlet-Agent `run.jsonl` was
checked directly for `run_error` events before trusting any verdict:

| rep | gauntlet.status | `run_error` | classification |
|---|---|---|---|
| spike rep1/2/3 | pass/pass/pass, full reasoning | 0/0/0 | clean |
| bounded rep1 | investigate, full reasoning (re: ceremony overhead) | 0 | clean — genuine subjective call, not an error |
| bounded rep2/3 | pass/pass, full reasoning | 0/0 | clean |
| **arch rep1** | investigate, **blank** summary/reasoning | **1: `500 {"type":"error","error":{"type":"api_error","message":"Internal server error"}}`** | **outage-tainted, excluded** |
| **arch rep2** | investigate, **blank** summary/reasoning | **1: `529 {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}`** | **outage-tainted, excluded** |
| arch rep3/4/5 | pass/pass/investigate, all full reasoning | 0/0/0 | clean |

arch rep5's `investigate` (Task 3 still in progress when the scenario's
30-minute time budget expired) is a genuine, content-rich judgment, not an
error — the Gauntlet cited real intermediate commits (design doc `78c242e`,
plan `afdf40f`, Task 1 clean at `2acbaf8`, Task 2 clean at `e87d700`). Ran
to completion, not truncated by an outage — included.

**arch rep1/rep2 are excluded from every table below.** Their Gauntlet
processes crashed mid-session on a live API error; the coding session's
own duration/token counts look superficially normal, but the interactive
loop (the Gauntlet driving Codex's clarifying questions) was cut short by
the crash, not by the scenario reaching a natural stop — not reliable
ceremony-timing data. Real spend on the two tainted reps ($4.54) is
included in the budget ledger for honesty, not counted toward the 9
scored reps.

## `checks.sh` bug found and fixed mid-task (scenario-authoring lesson)

The first 8 battery runs all came back `final: fail`/`indeterminate`
despite 6 of them having `gauntlet.status: pass` with full, coherent
reasoning. Root-caused by reading the evals check-DSL source directly
(`src/check/verbs.ts` `verbToolCalled`, `src/normalize/openclaw.ts`'s
`spawn_agent -> "Agent"` mapping, `src/composer.ts`'s `final = 'fail'`
whenever any post-check fails regardless of `gauntlet.status`):
`checks.sh`'s `post()` included `check-transcript tool-called Agent`,
copy-pasted verbatim from `cx-sdd-small`/`cx-branch-review`, where
subagent dispatch is the expected shape. None of the three ceremony
scenarios' acceptance criteria require dispatching a subagent — a
correctly-completing single-session run (confirmed on all three classes,
including arch via `.gitignore`+worktree-in-place-without-dispatch on
rep3/4) never calls `spawn_agent`, so this check always failed,
regardless of real task success.

**Scenario-authoring design rule, for the campaign closeout: a scenario's
deterministic post-checks must not assert a behavioral choice the
experiment itself measures.** Requiring subagent dispatch as a pass
condition would have biased E4's own ceremony census toward inflated
dispatch/ceremony rates — the opposite of a neutral instrument.

**Fix:** dropped `check-transcript tool-called Agent` from `post()` in all
three `checks.sh` files, keeping only the rollout `file-exists` check.
Committed separately (`fix(codex-efficiency): drop tool-called Agent
post-check...`) with the full diagnosis, ahead of the implementation
commit. Verified working: spike rep3 (first rep run under the fixed
checks) came back `final: pass`. This did not require re-running the 6
already-clean pre-fix reps — their rollouts were never invalid, only
their quorum verdict label was a false negative; `score_e4.py` reads
rollouts directly and was never affected either way.

## Census tables

Per-rep (9 clean reps: spike 1-3, bounded 1-3, arch 3-5; arch rep1/2
excluded, evidence above):

| class | rep | no-patch | user turns | docs written | tool calls | wall-clock (s) |
|---|---:|---|---:|---:|---:|---:|
| spike | 1 | YES | N/A | 0 | N/A | N/A |
| spike | 2 | YES | N/A | 0 | N/A | N/A |
| spike | 3 | YES | N/A | 0 | N/A | N/A |
| bounded | 1 | no | 4 | 2 | 13 | 246 |
| bounded | 2 | no | 5 | 2 | 19 | 284 |
| bounded | 3 | no | 6 | 2 | 18 | 311 |
| arch | 3 | no | 6 | 2 | 21 | 466 |
| arch | 4 | no | 5 | 2 | 21 | 378 |
| arch | 5 | no | 8 | 2 | 30 | 829 |

Per-class summary:

| class | n | no-patch reps | mean user turns | mean docs written | mean tool calls | mean wall-clock (s) |
|---|---:|---:|---:|---:|---:|---:|
| spike | 3 | 3/3 | N/A | 0.0 | N/A | N/A |
| bounded | 3 | 0/3 | 5.0 | 2.0 | 16.7 | 280.6 |
| arch | 3 | 0/3 | 6.3 | 2.0 | 24.0 | 557.5 |

## Between-class comparison against the registered prediction

**Registered prediction:** ceremony census is statistically
indistinguishable across spike/bounded/architectural task classes
(baseline, Task 1). **Discrimination-gate metric, registered before
scoring:** spike-class mean tool-calls-before-T within 25% of arch-class
mean tool-calls-before-T.

**Primary gate result: inconclusive-by-zero — but not for either reason
named in the pre-registration.** The pre-registration named two live
possibilities for a null result: (a) the `brainstorming` hard-gate isn't
actually binding in practice, or (b) this fresh-session scenario shape is
too weak to elicit the hard-gate at all. **Neither explanation fits what
the data actually shows.** All 3 spike reps show `no_non_doc_patch=True`
— confirmed by hand, zero `patch_apply_end` events of ANY kind (not just
non-doc ones) in any of the three spike rollouts. This is not "the model
skipped ceremony" or "the gate never fired" — it's structural: a
correctly-executed "find out, quick and dirty" spike investigates via
ephemeral inline shell/Python (verified directly — spike rep2's port-bind
reproduction is a `python3 - <<'PY' ... PY` heredoc inside an
`exec_command` call, never touching a tracked file), so there is no
tracked-file code change for "ceremony before code" to be measured
against at all. **A third explanation, not registered in advance:** the
metric itself (ceremony-before-first-tracked-code-change) is undefined,
not zero, for a task class whose correct behavior never produces a
tracked-file change. This is itself informative — arguably the *most*
proportional possible outcome (a spike that touches nothing durable) — but
it means the primary gate cannot discriminate on this task class, and that
is reported honestly rather than reframed as either a pass or a fail of
the predicted pathology.

**Secondary comparison, not gated (bounded vs. arch, the two classes where
T exists in every rep):** mean tool-calls-before-T is 16.7 (bounded) vs.
24.0 (arch) — a 30.4% difference, just outside the pre-registered 25% band
— so ceremony volume is *not* flat between these two classes; it scales
somewhat with task complexity. But the **planning-artifact shape is
identical**: every rep in both classes writes exactly 2 docs before any
code (a design spec then a plan, the brainstorming→writing-plans sequence)
— confirmed by hand for bounded rep1 (`docs/superpowers/specs/
2026-07-29-quiet-request-logging-design.md` then `docs/superpowers/plans/
2026-07-29-quiet-request-logging.md`) and consistent across every other
rep in both classes. So the ceremony *template* is invariant across
bounded and arch (always design doc → plan doc, regardless of a
one-file-flag task vs. a multi-file architectural split) while its
*volume* (tool calls, wall-clock) scales moderately. This is a nuanced,
partial version of the registered pathology: not "identical regardless of
complexity" (volume does move), but also not "proportional to complexity"
in the sense of skipping ceremony for a simpler bounded change — the
same two-document ritual runs every time.

## Micro results

`ceremony-path-micro.py`, MODEL=claude-opus-4-8, REPS=5 (45 calls, all
completed before the FULL battery — unaffected by the later API outage,
confirmed no error content in any of the 45 cached answer files):

| variant | spike | bounded | arch |
|---|---:|---:|---:|
| Z-null | SPIKE 5/5 | BOUNDED 5/5 | FULL 5/5 |
| A-current (verbatim hard-gate) | SPIKE 5/5 | **FULL 5/5** | FULL 5/5 |
| B-three-path (drafted router) | SPIKE 5/5 | BOUNDED 5/5 | FULL 5/5 |

**Z-null and B-three-path both differentiate perfectly and identically**
(spike→SPIKE, bounded→BOUNDED, arch→FULL, 5/5 every cell) — the model's
own judgment, with NO entry-decision guidance at all, already scales
ceremony appropriately. **A-current is the only variant that fails to
differentiate**: it pushes the bounded task into FULL ceremony 5/5 times,
identical to its arch treatment. This directly corroborates the audit's
Finding 4 concern in miniature: the current hard-gate's absolute wording
("This applies to EVERY project regardless of perceived simplicity")
measurably erases the spike/bounded distinction the model would otherwise
draw on its own. This is treatment-phrasing pre-work only — B-three-path
is a drafted paragraph, not proposed for adoption without further
evaluation, and no skill edits land in this campaign.

## Manual inspection

**Micro (45 answer files):** every one of the 45 cached responses is
exactly one word (`wc -w`: all 45 return `1`), matching one of
`SPIKE`/`BOUNDED`/`FULL` exactly — zero unparseable, zero multi-word, zero
error content. The forced-format instruction worked perfectly; the
classifier regex never had to do any interpretive work.

**Battery (9 reps), every field of one rep hand-verified against raw
rollout JSON, not just reproduced by construction (bounded rep1):**
`patch_apply_end` events read by hand show two doc patches (design spec
19:24:58, plan 19:26:04) then the first non-doc patch (`tests/
test_server.py`) at 19:27:22.703 — user_message timestamps before that
point: 4 (19:23:46, 19:24:48, 19:25:40, 19:26:58), matching the scorer's
`user_turns=4` exactly. A by-hand recount of `TOOL_CALL_TYPES` records
before the same timestamp: 13, matching `tool_calls=13` exactly. Root's
first record timestamp: 19:23:16.564; T − start = 246.14s, matching
`wall_clock=246` exactly.

**A genuine, reproducible edge case in the classification rule, found and
reported, not silently absorbed:** all 3 arch reps' first non-doc patch is
a `.gitignore` addition (arch's worktree-setup step), 40-90s before the
first real implementation file change (`tests/test_server.py` in every
case) — `.gitignore` is neither under `docs/` nor `*.md`, so it correctly
classifies as non-doc under the registered rule, but it is repo-hygiene,
not service code. Reported exactly, not adjusted post-hoc: this shifts
arch's `tool_calls_before_T`/`wall_clock_to_T` slightly earlier than "the
first line of real implementation," by tens of seconds against a
multi-hundred-second total — small enough not to change the qualitative
finding, but real enough to flag for anyone reusing this classification
rule.

**Spike's zero-patch result, independently confirmed, not taken from the
scorer alone:** `grep -c '"patch_apply_end"'` against all 3 spike root
rollouts directly returns `0` in every case — the scorer's
`no_non_doc_patch=True` for all 3 spike reps is not a classification
artifact of the doc/non-doc split; there is nothing to classify.

## Budget ledger

| Date | Battery | $ cost | Sub used_percent before | Sub used_percent after |
|---|---|---|---|---|
| 2026-07-29/30 | E4 ceremony census (dev, cx-ceremony-{spike,bounded,arch}, 3 reps/class + 2 outage-tainted arch reps) | $21.39 ($16.85 clean, scored + $4.54 outage-tainted, excluded) | 18.0% | 55.0% |

Full per-rep economics in the run transcripts; clean-scored total by
class: spike $1.23, bounded $4.71, arch (3 clean reps) $10.91. Campaign
running total after this battery: **$104.45** (previous $83.06 + this
battery's $21.39), well under the $250 checkpoint — the full 3-reps/class
battery proceeded as planned, no fallback to 2 reps/class needed.

## Concerns / scope notes

1. **`.gitignore`-as-first-non-doc-patch** (above) — a real, reproducible
   3/3 pattern for arch, not fixed in this task (the registered
   classification rule is doc-vs-not, not code-vs-hygiene; changing it
   post-hoc after seeing this pattern would violate the campaign's
   pre-registration discipline).
2. **Spike's structural zero-patch result** means E4's census metric, as
   designed, cannot discriminate spike from anything — any future work on
   this axis needs either a different anchor point (e.g. first tool call
   of any kind, or first `exec_command` matching a code-execution shape)
   or to accept that "ceremony before tracked code" is simply the wrong
   question for investigate-only task classes.
3. **`checks.sh` design rule** (above) — recommend carrying into the
   campaign closeout doc as a general scenario-authoring lesson, not
   scoped to E4 alone (any future scenario reusing `tool-called Agent` or
   a similarly dispatch-presupposing check should check whether the task
   actually requires dispatch first).
4. **No treatment arm** — DESIGN.md scopes E4 as MINE → MICRO → FULL
   baseline only; this task delivered exactly that. `ceremony-path-micro.py`
   is explicitly pre-work for a future treatment, not a treatment result.
