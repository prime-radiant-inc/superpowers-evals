# E8 close_agent hygiene census (Amendment 1, MINE tier)

**Pre-registration:** `logs/2026-07-28-codex-efficiency.md`, "E8
PRE-REGISTRATION" entry (2026-07-29), committed before any of this scorer's
code (`rollout_parser.lifecycle_calls()`, `score_e8.py`) existed.

**Status: all three predicted clauses CONFIRMED.** Every controller in
every corpus we scored either closes essentially everything it spawns
(codex-5_5, `multi_agent_v1` namespace) or closes essentially nothing
(every other controller scored, `collaboration` namespace). There is no
partial-closure middle ground anywhere in this data — see "Prediction
check" below.

## Scorer design (`score_e8.py` + `rollout_parser.lifecycle_calls()`)

`rollout_parser.lifecycle_calls(path)` extracts every
`close_agent`/`interrupt_agent`/`followup_task`/`resume_agent`/`list_agents`
`function_call`, mirroring `extract_spawns()`'s envelope handling exactly:
a `function_call` under `response_item`, `namespace` NOT filtered on.
Confirmed directly against real rollouts (not assumed): `close_agent`
appears under both the `collaboration` namespace (our battery runs, most
of the audit corpus) and the `multi_agent_v1` namespace (Drew's codex-5_5
run, some audit sessions), with an identical `{"target": "<agent id>"}`
argument shape in both — so, like `wait_outcomes()` and unlike
`extract_spawns()`'s `fork_turns`/`task_name` fields, `lifecycle_calls()`
needed no namespace-specific branch. None of the five tools carry a
`task_name` argument in any rollout inspected, so `args_task_name` is
`"(omitted)"` for essentially every call — kept anyway for structural
symmetry with `Spawn`.

`score_e8.py` computes, per session: spawn count (`extract_spawns()`),
close_agent count, closure rate (`close/spawn`, a raw within-session
call-count ratio — chosen specifically to match Drew's own `sessions.json`
`tool_calls` semantics exactly, since that's what his shipped numbers use
and what we're cross-validating against), plus
interrupt_agent/followup_task/resume_agent/list_agents counts for context.
A session counts as a **controller** iff it has ≥1 spawn.

**Privacy note (a real constraint discovered while building this, not
assumed in advance):** a `close_agent` call's `function_call_output`
carries `{"previous_status": {"completed": "<the child's full final
message/report>"}}` — verified directly against a real audit rollout
during this task's build. Unlike `wait_agent`'s short, content-free status
envelope (E7), `close_agent`'s output can contain an entire child session's
final report text. `lifecycle_calls()` never reads `function_call_output`
at all — it only ever parses the calling `function_call`'s `arguments` —
so this scorer has no code path that could leak that content, by
construction, not by a print-time filter.

## Corpus (a): Drew Ritter's external SDD head-to-head corpus

Read-only, external, never committed beyond these aggregates
(`/Users/jesse/git/superpowers/_tmp/drew-sdd-head-to-head-2026-07-27`).
Discovery reused `drew_adapter.py`'s `RUNS`/`discover()`, exactly as
`score_e7.py` does.

| Run | Sessions scored | Controllers | Spawns | close_agent | Closure rate | Controllers w/ any close | Context: interrupt / followup / resume / list |
|---|---:|---:|---:|---:|---:|---:|---|
| codex-5_5 (root + 18 children) | 19 | 1 | 18 | 18 | **100.0%** | 1/1 | 0 / 0 / 0 / 0 |
| sol-5_6 (root + 19 children) | 20 | 1 | 19 | 0 | **0.0%** | 0/1 | 0 / 4 / 0 / 3 |
| stress-2703 (root + 67 children, 2 controllers: root + 1 depth-2) | 68 | 2 | 84 | 0 | **0.0%** | 0/2 | 6 / 99 / 0 / 49 |

Every one of codex-5_5's 18 `close_agent` calls was independently
re-verified against the raw rollout bytes (not taken on the scorer's word):
`grep -c '"type":"function_call".*"name":"close_agent"'` on the root
rollout returns 18; the scorer's first and last extracted
(`call_id`, `timestamp`) pairs
(`call_ontuNV2VR2KYJtp8jfvmumwh`/`2026-07-25T08:13:06.087Z` and
`call_V7OXy3us1kO2658LfrSSTqrG`/`2026-07-25T09:22:46.748Z`) match a direct
Python re-scan of the same file exactly.

**Cross-check against Drew's own `sessions.json` (bypassing our scorer
entirely, root sessions only):** `tool_calls.spawn_agent`/`tool_calls.close_agent`
— codex-5_5: 18/18 (**exact match**); sol-5_6: 19/`close_agent` key absent
(**exact match**, 0); stress-2703 root: 83/`close_agent` key absent
(**exact match**, 0 — our own 84 includes the depth-2 controller's 1 extra
spawn that his root-only `sessions.json` record structurally can't see).
`interrupt_agent`/`followup_task`/`list_agents` also cross-checked and
match exactly at the root level (sol-5_6: 0/4/3; stress-2703 root: 6/99/47
— our stress-2703 total of 49 `list_agents` = his root's 47 + the depth-2
controller's own 2).

**`dispatch.json` does NOT carry close_agent data — checked directly, not
assumed.** Both copies (`analysis/metrics/dispatch.json` and
`analysis/stress-2703/metrics/dispatch.json`) contain only per-spawn
dispatch tuples (`args`, `hint`, `hint_honored`, etc.) — no `close_agent`
field anywhere in either file. The close/spawn counts Drew's own materials
cite (and that this task's brief names as "sol 0/86") come from
`sessions.json`'s `tool_calls` census and `report-addendum.md`, not
`dispatch.json`. "Sol 0/86" reconciles as sol-5_6's 19 + stress-2703's 67
(his children-file-count denominator) = 86, both zero — confirmed; our own
scorer's denominator (`extract_spawns()`'s raw call count: 19 for sol-5_6,
84 for stress-2703's whole tree) differs from his numerically but agrees
on every numerator (zero).

## Corpus (b): 2026-07-28 audit corpus

Read-only (`/Users/jesse/.codex/visualizations/2026/07/28/019fa9a2-87b7-73b1-a76a-efb9f14abbea/`
and the underlying `~/.codex/sessions/` rollouts). Both populations reuse
`score_e7.py`'s own selection code directly (`_load_manifest`,
`_resolve_manifest_path`, `_direct_human_sol_candidates`,
`HIGH_WAIT_ROOT_ID`) — imported, not re-derived, so the "direct human
gpt-5.6-sol" proxy population can't silently drift between the two
scorers.

| Group | Sessions scored | Controllers | Spawns | close_agent | Closure rate | Context: interrupt / followup / resume / list |
|---|---:|---:|---:|---:|---:|---|
| High-wait Remux root (E7's Finding 7 root, `019f95af-...`, model `gpt-5.6-luna`) | 1 | 1 | 123 | 0 | **0.0%** | 13 / 71 / 0 / 104 |
| Direct-human-`gpt-5.6-sol` sample (E7's wait-active subset of the 214-root proxy pool) | 3 | 2 | 16 | 0 | **0.0%** | 3 / 25 / 0 / 29 |

The high-wait root's `spawn_agent`/`close_agent`/`interrupt_agent`/
`followup_task`/`list_agents` counts (123/0/13/71/104) match
`metrics-all.jsonl`'s pre-existing `tool_counts` for that session exactly
— cross-checked directly, not just via `lifecycle_calls()`.

The direct-human-sol proxy population (same 214-candidate pool E7
documented: depth-0, `thread_source:"user"`, `model:"gpt-5.6-sol"`,
root-family ≤20 sessions) is thin for this specific question: only 2 of
214 candidates have any `spawn_agent` activity at all (16 raw calls
combined), so this is a small base — flagged here as thin, not as a
surprise discovered after the fact (the pre-registration entry already
flagged it as thin before this scorer ran).

## Corpus (c): our own `cx-eff-cx-sdd-small` battery runs (Tasks 6/6b)

`/Users/jesse/git/superpowers/superpowers/evals/results/cx-eff-cx-sdd-small-{dev,spinout}-rep*`
(14 quorum reps total: 6 `dev`, 8 `spinout`, from Tasks 6/6b). Discovery
reused `score_e1.py`'s `find_rollouts()`, exactly as `score_e7.py` does.
No privacy concern — these are our own eval-container runs.

| Arm | Sessions scored | Controllers | Spawns | close_agent | Closure rate | Context: interrupt / followup / resume / list |
|---|---:|---:|---:|---:|---:|---|
| dev (6 reps) | 54 | 6 | 48 | 0 | **0.0%** | 0 / 0 / 0 / 9 |
| spinout (8 reps) | 75 | 10 | 67 | 0 | **0.0%** | 0 / 3 / 0 / 12 |

`followup_task` appears exactly 3 times, only in the spinout arm (reps
3/7/8) — matching the pre-registration's grep-confirmed prediction exactly
(counts, not just direction).

## Prediction check

Pre-registered 2026-07-29, before this scorer existed
(`logs/2026-07-28-codex-efficiency.md`).

1. **Drew's sol controllers 0/86 vs. codex-5_5 18/18, reconciled figures.**
   **CONFIRMED.** codex-5_5: 18/18 (100.0%). sol-5_6: 0/19. stress-2703:
   0/84 (our own scorer's denominator; 0/67 under Drew's children-count
   denominator — both agree the numerator is zero). Independently
   re-verified against raw rollout bytes and against Drew's own
   `sessions.json`, not just reproduced by the scorer.
2. **Audit corpus, window-scoped near-zero close_agent among the
   populations E7 already selected.** **CONFIRMED.** High-wait Remux
   root: 0/123. Direct-human-sol proxy sample: 0/16 (thin population, as
   flagged in the pre-registration). Neither population shows any
   `close_agent` activity at all — stronger than "near-zero," exactly
   zero in every session scored.
3. **Our own battery runs, both arms, controllers do not close children.**
   **CONFIRMED.** dev: 0/48. spinout: 0/67. Zero `close_agent` calls in
   any of the 14 scored reps, matching the grep-confirmed pre-registration
   exactly.

No clause required reframing or partial credit — this is the cleanest
3-for-3 result in the campaign's Amendment-1 tasks so far. The underlying
pattern across every corpus scored is binary, not graded: a controller
either closes essentially all its spawned children (codex-5_5's
`multi_agent_v1`-namespace run, 18/18) or closes essentially none of them
(every other controller scored, all `collaboration`-namespace runs, 0/N
each). This task did not attempt to explain why codex-5_5 is the sole
exception (different model/harness config, not investigated here) — noted
as an open question in Concerns below, not adjudicated.

## Manual inspection: every close_agent call found (n=18)

The pre-registration predicted "near-zero" close_agent activity almost
everywhere, so per the task brief this section lists **every** matching
call found across all five session groups scored above, rather than a
random sample — there were few enough to do so. All 18 are from
codex-5_5's single controller session; every other group scored zero.
`call_id`/`timestamp`/`args_task_name` only — `lifecycle_calls()` never
reads `function_call_output`, so no child message/report content is ever
touched by this listing (see the privacy note above).

```
1.  call_id=call_ontuNV2VR2KYJtp8jfvmumwh  timestamp=2026-07-25T08:13:06.087Z  args_task_name='(omitted)'
2.  call_id=call_eXEMQhOI6f00K4IqpP4ZK2di  timestamp=2026-07-25T08:13:06.088Z  args_task_name='(omitted)'
3.  call_id=call_iZKrzUO0UPFJ7ON7MlJytqu3  timestamp=2026-07-25T08:20:30.857Z  args_task_name='(omitted)'
4.  call_id=call_hPilYz55kjtuDeg68viDZZpm  timestamp=2026-07-25T08:20:30.858Z  args_task_name='(omitted)'
5.  call_id=call_8Qg0c1pJxn3WW8foMRMFkd3K  timestamp=2026-07-25T08:28:33.918Z  args_task_name='(omitted)'
6.  call_id=call_SGnbsZ19HMUnfiub0N9frj7e  timestamp=2026-07-25T08:28:33.919Z  args_task_name='(omitted)'
7.  call_id=call_rzXICjPc4IX4FaZcYH6nnLph  timestamp=2026-07-25T08:38:03.448Z  args_task_name='(omitted)'
8.  call_id=call_AvOMeQCjVLIL07KWOwmMJODc  timestamp=2026-07-25T08:38:03.448Z  args_task_name='(omitted)'
9.  call_id=call_elKlXZ5ySB6kVjTUOcZ061Mv  timestamp=2026-07-25T08:45:56.548Z  args_task_name='(omitted)'
10. call_id=call_s1Bhv54cr84MPrQSTT85546I  timestamp=2026-07-25T08:45:56.558Z  args_task_name='(omitted)'
11. call_id=call_K70CxmPH4RITmQgaBsMykvZS  timestamp=2026-07-25T08:54:37.316Z  args_task_name='(omitted)'
12. call_id=call_g4KMtRSjtuB7rhEcjP6UV2Gb  timestamp=2026-07-25T08:54:37.316Z  args_task_name='(omitted)'
13. call_id=call_rvFD6nNima8iKFl8Aj4E0wHi  timestamp=2026-07-25T09:15:55.226Z  args_task_name='(omitted)'
14. call_id=call_jFuF3Z8ccbWFnmpYgLvulmdJ  timestamp=2026-07-25T09:15:55.227Z  args_task_name='(omitted)'
15. call_id=call_9ZR4pkFhVfUIjwZ3eDIJwLyC  timestamp=2026-07-25T09:15:55.232Z  args_task_name='(omitted)'
16. call_id=call_gJItFsA1rdwk8jTBEzTtAmz2  timestamp=2026-07-25T09:22:46.717Z  args_task_name='(omitted)'
17. call_id=call_4oXjwhxNAUyx4ruFu7ibi3qP  timestamp=2026-07-25T09:22:46.738Z  args_task_name='(omitted)'
18. call_id=call_V7OXy3us1kO2658LfrSSTqrG  timestamp=2026-07-25T09:22:46.748Z  args_task_name='(omitted)'
```

Calls arrive in same-timestamp pairs/triples (e.g. #1-2, #3-4, #11-12,
#13-15, #16-18) — consistent with codex-5_5's controller closing multiple
just-completed children back-to-back in the same turn, rather than one at
a time. All 18 `args_task_name` values are `"(omitted)"`, as predicted
(`close_agent`'s only argument is `target`, never `task_name`) — none were
misclassified or coerced into a non-omitted value.

## Concerns / restrictions for future use

- **Closure rate is a raw within-session call-count ratio, not a
  target-id-matched measure.** `close_agent`'s argument is `target: <agent
  id>`; this scorer counts calls, it does not verify that the `target`
  values resolve to the same session's actually-spawned children (via
  `child_links()`), or that no `target` is closed twice. This was a
  deliberate scope decision — the task brief's `LifecycleCall` dataclass
  has no `target` field, and a raw-count ratio is what's needed to
  cross-validate against Drew's own `sessions.json` semantics (also a
  raw-count ratio, verified above). A future scorer wanting "did every
  actually-spawned child specifically get closed" would need to add a
  `target` field and reuse `child_links()`.
- **Why codex-5_5 is the one 18/18 exception was not investigated.**
  It's also the corpus's only `multi_agent_v1`-namespace run — whether
  that's the explanatory variable (a harness/tool-schema difference) or
  coincidental (a more disciplined controller run) isn't adjudicated here.
- **The direct-human-`gpt-5.6-sol` proxy population is thin for this
  question** (2 of 214 candidates have any spawn activity, 16 total
  spawns) — same population E7 already flagged as its own mechanical
  proxy, not a reproduction of the audit's Finding 8 selection. Treat the
  0/16 figure as consistent with the pattern, not as strong independent
  confirmation at scale.
- **`n_controllers_fully_closed`** (a controller whose `close_agent` count
  is ≥ its spawn count) happens to equal `n_controllers_with_any_close`
  in every group scored here (both are binary: 0 or all) — this is a
  property of the data scored, not a guarantee the metric enforces; a
  controller that partially closes (e.g. 3 of 7) would show up correctly
  as `with_any_close=1, fully_closed=0` if one existed, but none did in
  any corpus available to this task.
