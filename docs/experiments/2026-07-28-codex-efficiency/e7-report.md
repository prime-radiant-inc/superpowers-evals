# E7 wait-polling census (Amendment 1, MINE tier)

**Pre-registration:** `logs/2026-07-28-codex-efficiency.md`, "E7
PRE-REGISTRATION" entry (2026-07-29), committed before any of this
scorer's code existed.

**Status: two of three predicted clauses CONFIRMED, one clause FAILS.**
Both external/audit timeout-rate figures reproduce almost exactly under
our own independently-built pairing logic. The third clause — that our
own short `cx-eff-*` battery runs would show *materially* lower timeout
rates — does not hold: our battery runs land only modestly below the
external corpora, not "materially" lower. See "Prediction check" below.

## Scorer design (`score_e7.py` + `rollout_parser.wait_outcomes()`)

`rollout_parser.wait_outcomes(path)` pairs every `wait_agent`
`function_call` to its later `function_call_output` (matched by
`call_id`) and classifies `timed_out` from the output's parsed JSON
`timed_out` boolean key. Two envelope shapes were found in real rollouts
and are both handled (see the module docstring for the exact strings):
the `collaboration`-namespace `{"message":...,"timed_out":bool}` envelope
(audit corpus, Drew's sol-5_6/stress-2703, our own battery runs) and the
`multi_agent_v1`-namespace `{"status":{...},"timed_out":bool}` envelope
(Drew's codex-5_5 run) — both carry the same top-level `timed_out` key, so
no namespace-specific handling was needed (unlike `extract_spawns()`'s
`fork_turns`/`task_name` gap on that same namespace). Argument-validation
errors (bare-string outputs like `"timeout_ms must be at least 10000"`)
and calls with no matching output at all are excluded from the outcome
list rather than guessed at — every corpus we scored has at least one of
these, always a small fraction (see the per-group `excluded` counts
below).

`wait_outcomes()` deliberately scopes to function calls named exactly
`wait_agent`, not `parse_session()`'s broader `WAIT_NAMES` census set: the
bare `wait` tool is a *different* tool (waiting on a running script/build,
not a spawned agent) with an incompatible, `timed_out`-free output shape,
confirmed by direct inspection (`"Script completed\nWall time 8.0
seconds..."`, `"aborted by user after 16.1s"`); `wait_threads` was never
observed in any rollout we inspected.

`score_e7.py` additionally computes, per session: inter-poll interval
seconds (from *all* raw `wait_agent` call timestamps, not just paired
ones — polling cadence is observable regardless of outcome
classification) and a cache-read rebill estimate. The estimate uses the
"attributed" method (summing `token_count` events' `cached_input_tokens`
deltas that fall strictly between two consecutive `wait_agent` calls)
whenever at least 90% of a session's inter-poll intervals contain at
least one `token_count` event; every session scored below hit that bar
(no session fell through to the coarser proxy), which turned out to be
unexpectedly clean — Codex emits a `token_count` event around essentially
every model turn, including turns that do nothing but re-issue
`wait_agent`.

## Corpus (a): Drew Ritter's external SDD head-to-head corpus

Read-only, external, never committed beyond these aggregates
(`/Users/jesse/git/superpowers/_tmp/drew-sdd-head-to-head-2026-07-27`).
Discovery reused `drew_adapter.py`'s `RUNS`/`discover()`.

| Run | Sessions scored | Calls | Paired | Excluded | Timed out | Rate/paired | Rate/all calls | Inter-poll p50 / p95 | Cache-rebill attributed |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| codex-5_5 (root+18 children, only root has waits) | 19 | 26 | 26 | 0 | 7 | 26.9% | 26.9% | 149.96s / 293.10s | 10,014,336 tok (1 session) |
| sol-5_6 (root+19 children, only root has waits) | 20 | 68 | 68 | 0 | 46 | 67.6% | 67.6% | 64.02s / 89.23s | 22,901,760 tok (1 session) |
| stress-2703, **root only** | 1 | 805 | 804 | 1 | 630 | 78.4% | 78.3% | 59.09s / 97.67s | 369,050,112 tok (98.0% of the root's 376,578,304 total cache-read tokens) |
| stress-2703, full run (root + 67 children, 4 sessions have waits) | 68 | 816 | 813 | 3 | 638 | 78.5% | 78.2% | 58.34s / 97.76s | 371,610,112 tok (3 sessions) |

The stress-2703 root's raw call count (805) and timeout split
(630 `timed_out:true` / 174 `timed_out:false` / 1 excluded
argument-validation error) match the pre-registration's cited prior
(~78% of ~805) almost exactly.

## Corpus (b): 2026-07-28 audit corpus

Read-only (`/Users/jesse/.codex/visualizations/2026/07/28/019fa9a2-87b7-73b1-a76a-efb9f14abbea/`
and the underlying `~/.codex/sessions/` rollouts).

| Group | Sessions scored | Calls | Paired | Excluded | Timed out | Rate/paired | Rate/all calls | Inter-poll p50 / p95 | Cache-rebill attributed |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| High-wait Remux root (Finding 7's root, `019f95af-...`) | 1 | 1058 | 1050 | 8 | 788 | 75.0% | **74.5%** | 43.39s / 131.85s | 381,828,608 tok (92.6% of the session's 412,323,072 total cache-read tokens) |
| Direct-human-`gpt-5.6-sol` sample (wait-active subset, see below) | 3 | 211 | 209 | 2 | 168 | 80.4% | 79.6% | 40.75s / 183.24s | 424,273,920 tok (3 sessions) |

The high-wait root's split (788 `timed_out:true` / 262 `timed_out:false` /
7 `"timeout_ms must be at least 10000"` argument errors / 1 malformed-call
error = 1058 raw calls) matches the audit's published Finding 7 figure
(788/1058, 74.5%) **exactly**.

**"Direct human `gpt-5.6-sol` task roots" — not a reproduction of Finding
8's population.** The audit's own methodology section describes Finding
8's corpus as "deep-read every ... direct human `gpt-5.6-sol` task" —
manual selection, not an algorithmic filter — so we could not reconstruct
its exact 9-root/111-skill-read set from `session-manifest.json` alone,
and did not fabricate a match. `score_e7.py` instead documents its own
mechanical proxy (see `_direct_human_sol_candidates()`'s docstring):
depth-0, `thread_source:"user"`, `model:"gpt-5.6-sol"` root sessions whose
root-family has ≤20 total sessions (excluding the audit's four/five
multi-hundred-session dominant families). That pool has **214** candidate
roots; only **3** of them have any `wait_agent` activity at all (the
other 211 never spawned+waited on anything) — those 3 are the "wait-active
subset" scored above (8, 3, and 200 raw calls respectively). This is
weak, exploratory support at best (n=3, our own proxy definition, not the
audit's), reported for completeness rather than as independent
confirmation of anything.

## Corpus (c): our own `cx-eff-cx-sdd-small` battery runs (Tasks 6/6b)

`/Users/jesse/git/superpowers/superpowers/evals/results/cx-eff-cx-sdd-small-{dev,spinout}-rep*`
(14 quorum reps total: 6 `dev`, 8 `spinout`, from Tasks 6/6b). Discovery
reused `score_e1.py`'s `find_rollouts()`.

| Arm | Sessions scored | Sessions w/ waits | Calls | Paired | Excluded | Timed out | Rate/paired | Rate/all calls | Inter-poll p50 / p95 | Cache-rebill attributed |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| dev (6 reps) | 54 | 6 | 158 | 153 | 5 | 106 | 69.3% | 67.1% | 24.90s / 51.27s | 12,512,256 tok (6 sessions, 43.3% of these sessions' combined 28,926,720 total cache-read tokens) |
| spinout (8 reps) | 75 | 9 | 201 | 195 | 6 | 121 | 62.1% | 60.2% | 32.16s / 102.62s | 17,784,320 tok (9 sessions, 42.5% of these sessions' combined 41,810,944 total cache-read tokens) |

Every excluded call in this corpus (1 per session that has any excluded
call, 11 total) is the same shape seen in the audit root: an initial
`wait_agent(timeout_ms=1000)` attempt that the tool rejects with
`"timeout_ms must be at least 10000"` before any real polling starts.

## Prediction check

Pre-registered 2026-07-29, before this scorer existed
(`logs/2026-07-28-codex-efficiency.md`).

1. **Drew's stress-2703 run: ~78% of ~805 polls time out.** **CONFIRMED.**
   805 raw calls (matches "~805" exactly), 78.3% of all calls / 78.4% of
   paired outcomes time out (matches "~78%" almost exactly).
2. **Audit corpus high-wait root: ~74% (788/1058).** **CONFIRMED,
   exactly.** 788/1058 = 74.48%, reproducing the audit's own published
   Finding 7 figure to the token via an independently-built parser and
   pairing algorithm, not by construction (the root was identified from a
   pre-existing counter before `wait_outcomes()` existed; the 788/1058
   split itself is `wait_outcomes()`'s own output).
3. **Our own `cx-eff-*` battery runs show materially lower timeout
   rates.** **FAILS.** dev: 67.1% (rate/all calls) / 69.3% (rate/paired).
   spinout: 60.2% / 62.1%. These are 10-20 percentage points below the
   two external/audit figures (74-80%) — genuinely lower, but not what
   "materially lower" was meant to convey when the prediction was
   registered (the intended contrast was against a scenario with brief
   child-agent lifetimes rarely still running when polled, which would
   read as a small fraction, not roughly two-thirds).

   **Reframing, not fixing the prediction after the fact:** the
   pre-registered rationale ("short task horizon gives spawned children
   little time to still be running when the controller polls") assumed
   the timeout rate tracks session *length/load*. The data instead
   suggests the timeout rate mostly tracks a mismatch between
   `wait_agent`'s typical poll timeout (10s/20s/30s, by far the most
   common `timeout_ms` values in every corpus scored, including a fresh
   3-task battery) and how long a spawned subagent actually takes to
   finish a real unit of work — which is commonly *longer* than one poll
   window even in a small, fresh scenario. That mismatch, not
   session-scale pathology, is what produces a majority-timeout rate
   almost everywhere `wait_agent` gets used at all. This is a genuine
   miss on the registered prediction, reported as such rather than
   reframed into a pass.

   One secondary, low-confidence observation not part of the registered
   prediction: `spinout`'s rate is somewhat lower than `dev`'s (60-62% vs
   67-69%) in this battery. Sample sizes are small (195 vs 153 paired
   calls) and no significance test was run — noted, not claimed as a
   `codex-spinout-fixes` effect.

## Manual inspection (n=10, seed=42, `random.Random(42).sample`)

Classification + raw marker text only, sampled across every session
scored above (no session/task content, per the campaign's "numbers only"
rule for the audit/Drew corpora):

```
1. [stress-2703]           timed_out=True  duration_hint=60000ms  {"message":"Wait timed out.","timed_out":true}
2. [stress-2703]           timed_out=True  duration_hint=30000ms  {"message":"Wait timed out.","timed_out":true}
3. [audit-high-wait-root]  timed_out=True  duration_hint=30000ms  {"message":"Wait timed out.","timed_out":true}
4. [audit-high-wait-root]  timed_out=False duration_hint=30000ms  {"message":"Wait completed.","timed_out":false}
5. [audit-high-wait-root]  timed_out=True  duration_hint=30000ms  {"message":"Wait timed out.","timed_out":true}
6. [stress-2703]           timed_out=True  duration_hint=30000ms  {"message":"Wait timed out.","timed_out":true}
7. [stress-2703]           timed_out=True  duration_hint=60000ms  {"message":"Wait timed out.","timed_out":true}
8. [battery-dev]           timed_out=False duration_hint=20000ms  {"message":"Wait completed.","timed_out":false}
9. [stress-2703]           timed_out=True  duration_hint=60000ms  {"message":"Wait timed out.","timed_out":true}
10.[battery-spinout]       timed_out=True  duration_hint=30000ms  {"message":"Wait timed out.","timed_out":true}
```

All 10 classifications match their raw marker text exactly (`"Wait timed
out."` → `timed_out=True`, `"Wait completed."` → `timed_out=False`) in
every sample, across all three corpora and both envelope namespaces
represented in the broader run (`collaboration` here; `multi_agent_v1`
verified separately on codex-5_5's 26/26 paired calls during scorer
development). No misclassification observed.

## Concerns / restrictions for future use

- The "direct human `gpt-5.6-sol` task roots" figure in corpus (b) is our
  own proxy, not Finding 8's population — do not cite it as reproducing
  "nine direct human tasks, 111 SKILL.md reads" from the audit report.
- Cache-rebill "attributed" tokens are a real usage-cost estimate, not a
  wasted-dollar figure: some of that cache-read traffic is unavoidable
  context resend on any tool turn. It should be read as "how much of this
  session's cache-read volume happened during the windows between
  consecutive polls," not as money that would vanish if polling were
  fixed.
- `n_excluded` (argument-validation errors, mostly the sub-10s
  `timeout_ms` rejection) is small everywhere scored (0-8 per session)
  and was not separately itemized beyond the aggregate `excluded` count —
  fine for a census, but a future scorer wanting error-shape breakdowns
  would need to extend `wait_outcomes()` or add a parallel accessor.
