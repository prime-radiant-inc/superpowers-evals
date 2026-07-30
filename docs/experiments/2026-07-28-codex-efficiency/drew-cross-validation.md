# Drew-corpus cross-validation (Amendment 1)

**Corpus (external, read-only, never committed):**
`/Users/jesse/git/superpowers/_tmp/drew-sdd-head-to-head-2026-07-27/sdd-testing-fresh/`
— Drew Ritter's SDD head-to-head package, all runs on superpowers
`codex-spinout-fixes @ bd68a949`, Codex Desktop CLI 0.146
(`session_meta.cli_version` reads `0.146.0-alpha.3.1` on every rollout
checked). Three Codex rollout sets scored:
`transcripts/{codex-5_5,sol-5_6}/rollouts/` (fractals head-to-head,
2026-07-25) and `transcripts/stress-2703/rollouts/` (12.4h real
interactive session, 2026-07-24). Tooling: `rollout_parser.py`
(unmodified) + `drew_adapter.py` (this task's thin discovery/aggregation
adapter — Drew's flat `rollouts/` layout doesn't match `score_e1.py`'s
quorum battery-dir convention, so run-dir discovery lives in the
adapter, not in `score_e1.py` or `rollout_parser.py`).

No stress-run task_name or message content appears anywhere below (stress-2703
is a private plan); fractals task_names are fine per the task scope and
appear where useful.

## 1. Parser + spawn-extraction results (all three runs)

Numbers below are `drew_adapter.py`'s output, i.e. `rollout_parser.py`'s
`extract_spawns`/`child_links`/`parse_session` run unmodified over every
rollout file in each run (root + all children/grandchildren), with depth
attributed from each rollout's own `session_meta.payload.source.subagent.
thread_spawn.depth` (present directly in the Codex Desktop rollout format).

| Run | Rollout files | `extract_spawns` total | fork_turns dist (literal field) | Explicit model | Depth dist (spawns by issuer depth) | Compactions (root/child/total) | wait_calls (root/total) | Files w/ ≥1 task_complete |
|---|---|---|---|---|---|---|---|---|
| codex-5_5 | 19 (1 root + 18) | 18 | `{"(omitted)": 18}` — schema gap, see §2 | 18/18 (100%) | `{0: 18}` | 0 / 0 / 0 | 26 / 26 | 19/19 |
| sol-5_6 | 20 (1 root + 19) | 19 | `{"none": 19}` | 19/19 (100%) | `{0: 19}` | 0 / 0 / 0 | 68 / 68 | 20/20 |
| stress-2703 | 68 (1 root + 67) | 84 | `{"none": 84}` | 83/84 (98.8%) | `{0: 83, 1: 1}` | 18 / 7 / 25 | 809 / 983 | 68/68 |
| **Aggregate** | **107** | **121** | | **120/121 (99.2%)** | | | | |

`parse_session()`'s regex-classifier `spawn_calls` total matches
`extract_spawns()`'s count exactly on every run (18/18, 19/19, 84/84) — the
two independently-coded predicates in `rollout_parser.py` agree, a useful
internal sanity check.

**Depth distribution, in full:** codex-5_5 and sol-5_6 are completely flat
— every spawn is issued by the root controller (depth 0), zero recursion,
zero depth-≥1 spawners, matching HANDOFF's "18/18 terra spawns" framing.
stress-2703 has exactly one non-root spawner: an **implementer-role**
child (depth 1) that itself issued one further `spawn_agent` call (depth-1
issuer → a depth-2 grandchild). That one recursive spawn is also the
**only** spawn in the entire 121-spawn corpus missing an explicit `model`
(fork_turns stayed `"none"`, so isolation didn't regress, only model
explicitness did). This is the same shape our own E1 CLI-0.146 re-test
found independently (`out/e1-retest-cli0146.md`: "both misses are
depth-2 spawns issued by an implementer child") — two independent corpora
now show the same pattern: recursive, child-initiated spawning is where
dispatch hygiene degrades, even when the root controller is 100% clean.

## 2. Schema finding (load-bearing for everything below)

Drew's three runs use **two different `spawn_agent` tool schemas**, not
one, despite matching `cli_version` strings:

- **`collaboration` namespace** (sol-5_6, stress-2703): arguments =
  `{fork_turns: str, task_name, model, reasoning_effort, message}` —
  identical shape to our own audit corpus / eval-container schema.
  `rollout_parser.extract_spawns()` reads this correctly; `fork_turns`
  and `task_name` are populated, not `"(omitted)"`.
- **`multi_agent_v1` namespace** (codex-5_5 only): arguments =
  `{fork_context: bool, model, reasoning_effort, message}` — **no
  `fork_turns` key and no `task_name` key at all.** Every codex-5_5 spawn
  therefore reads as `fork_turns: "(omitted)"` / `task_name: "(omitted)"`
  through `extract_spawns()` — correctly, per the field's own semantics
  (the key is genuinely absent from the JSON), but this is **not** a
  finding about codex-5_5's isolation behavior. A narrow adapter-level
  peek at the raw `fork_context` value (not added to `rollout_parser.py`)
  shows codex-5_5 is 18/18 `fork_context: false` — i.e. 100% isolated,
  same as the other two runs, just under a different key name.

Root cause, not guessed: `grep`ing each run's `tool_search_output` record
for the `spawn_agent` tool definition shows codex-5_5's controller was
handed the `multi_agent_v1` namespace's tool schema and sol-5_6/
stress-2703 were handed `collaboration`'s — a genuine per-session tool
surface difference on Drew's side (same CLI version string, different
schema), not a parsing defect.

**Consequence for `rollout_parser.child_links()` too:** codex-5_5's
rollout contains **zero** `event_msg`/`sub_agent_activity` records at all
(verified directly — event-type census on the root rollout has no such
key), so `child_links()` returns an empty map for every `multi_agent_v1`
run. This is why depth attribution above is read from each rollout's own
`session_meta` rather than reconstructed via `child_links()` — that
approach is authoritative for this corpus and doesn't depend on the
namespace. See §5 for why this is flagged as a concern, not fixed here.

## 3. Reconciliation: ours vs. his script-emitted metrics

| Run | Field | Ours (`rollout_parser`/`drew_adapter`) | His (`analysis/metrics/*.json`) | Verdict |
|---|---|---|---|---|
| codex-5_5 | spawn count | 18 | `dispatch.json`: 18 | **Match** |
| codex-5_5 | isolation | `fork_turns`: 100% `"(omitted)"` (native field) / adapter raw peek: 18/18 `fork_context: false` | `dispatch.json` args: 18/18 `fork_context: false` | **Match** via adapter-level cross-check only; **not comparable** via `extract_spawns`'s native `fork_turns` field (schema gap, §2) |
| codex-5_5 | explicit model | 18/18 | `dispatch.json`: 18/18 `model: gpt-5.6-terra` | **Match** |
| codex-5_5 | recursion | 0 (flat, depth 0 only) | narrative: "18/18 terra spawns... flawless" | **Match** (qualitative) |
| codex-5_5 | compactions | 0 | `sessions.json` root: `compaction.markers: []` | **Match** |
| codex-5_5 | wait_calls | 26 | `sessions.json` root `tool_calls.wait_agent`: 26 | **Match**, exact |
| codex-5_5 | close_agent | not measured (`rollout_parser` doesn't track this tool) | `sessions.json` root: 18/18 closed | **Not comparable** — outside current parser scope (E8's territory) |
| sol-5_6 | spawn count | 19 | `dispatch.json`: 19 | **Match** |
| sol-5_6 | isolation | `fork_turns`: 19/19 `"none"` | `dispatch.json`: 19/19 `fork_turns: "none"` | **Match**, exact (same schema) |
| sol-5_6 | explicit model | 19/19 | `dispatch.json`: 19/19 `model: gpt-5.6-terra` | **Match** |
| sol-5_6 | recursion | 0 | — | **Match** (flat) |
| sol-5_6 | compactions | 0 | `sessions.json` root: `compaction.markers: []` | **Match** |
| sol-5_6 | wait_calls | 68 | `sessions.json` root `tool_calls.wait_agent`: 68 | **Match**, exact |
| sol-5_6 | close_agent | not measured | `sessions.json` root: 0/19 closed (key absent) | **Not comparable** |
| stress-2703 | raw spawn count (root only) | 83 | `sessions.json` root `tool_calls.spawn_agent`: 83 | **Match**, exact |
| stress-2703 | raw spawn count (whole tree) | **84** (83 root + 1 depth-2, new number, not in his materials) | no equivalent whole-tree total found | **Ours only** — see below |
| stress-2703 | "clean" dispatch tuples | n/a (we don't apply his root-scoped dispatch filter) | `dispatch.json`: 66 | **Not comparable directly**; reconciled below |
| stress-2703 | isolation (of the 66 clean tuples) | 66/66 `"none"` (matches his `dispatch.json` args exactly, cross-checked) | `dispatch.json`: 66/66 `fork_turns: "none"` | **Match**, exact |
| stress-2703 | explicit model (of the 66) | 66/66 | `dispatch.json`: 66/66 | **Match** |
| stress-2703 | compactions (root) | 18 | `compaction.json`: `compacted_records: 18`, `context_compacted_events: 18` | **Match**, exact |
| stress-2703 | compactions (children) | 7 (across 4 files) | `compaction.json` `children`: 7 (across 4 sessions) | **Match**, exact |
| stress-2703 | wait_calls (root) | **809** | `sessions.json` root `tool_calls.wait_agent`: **805** | **Mismatch, fully reconciled**: our `WAIT_NAMES`/`WAIT_RE` classifier merges two distinct tool names his census keeps separate (`wait_agent`: 805 + `wait`: 4 = 809). Not a real discrepancy. |
| stress-2703 | child agents (rollout files) | **67** (66 root-linked + 1 depth-2 orphan) | HANDOFF headline: "67 child agents"; his `sessions.json` lists all 68 sessions (67 non-root), including the depth-2 one (`depth: 2`, `role: "other"`) | **Match**, exact, and independently root-caused (see below) |
| stress-2703 | task_complete (root) | 56 | `sessions.json` root `event_counts.task_complete`: 56 | **Match**, exact |
| stress-2703 | close_agent | not measured | `report-addendum.md`: 0/67 | **Not comparable** |

### The 83 → 66 → 67 chain, investigated to source (not hand-waved)

Three numbers from Drew's own materials look inconsistent at first glance
(83 raw spawn calls, 66 "clean" dispatch tuples, 67 child agents in the
HANDOFF headline). All three check out once traced to the actual rollout
bytes:

1. **83 raw `spawn_agent` calls, root only.** Matches his own
   `sessions.json` census exactly. Of the 83 distinct thread-ids his
   root's `sub_agent_activity` stream reports as "started," only **66**
   resolve to a persisted rollout file in the shipped package. The other
   **17** are not missing files — they're a **replay burst**: all 17
   have `spawn_agent` timestamps clustered in a ~150ms window
   (`22:27:19.603`–`22:27:19.745Z`) that is byte-identical to the
   timestamp of the run's first `compacted` record, which his own
   `compaction.json` tags `"phase": "replayed_import"`. That phase tag
   is Drew's own extraction script's label for exactly this mechanism:
   historical records re-emitted verbatim during a resume/reconstruction
   pass at session start, not fresh spawns issued in real time. His
   `dispatch.json`'s 66 "clean" tuples are the genuine, non-replayed
   subset — which is why our 66-resolved-to-file count matches his 66
   exactly.
2. **1 additional child, invisible to root-scoped extraction.** One
   non-root rollout file is not linked from root's `child_links()` at
   all. Tracing it: it was spawned by a **depth-1 implementer**, not by
   root (`parent_thread_id` in its own `session_meta` points to the
   depth-1 file, confirmed by that file's own `extract_spawns()` showing
   exactly one outgoing `spawn_agent` call). Drew's `dispatch.json` is
   root-scoped (it only walks root's own `spawn_agent` calls), so it
   structurally cannot see this one — consistent with it being absent
   from his 66. His broader `sessions.json`, however, *does* list it (68
   sessions total, `depth: 2`, `role: "other"`) — that's the source of
   the HANDOFF headline's "67 child agents," and it matches our own
   67 (66 resolved + 1 depth-2) exactly.
3. **Net:** 66 (clean, root-scoped, matches his dispatch.json) + 1
   (depth-2, matches his sessions.json but not his dispatch.json) = 67
   children (matches his HANDOFF headline). 83 (root raw) + 1 (the
   depth-2 spawn call itself, issued from the child's own rollout, not
   root's) = **84**, our own whole-tree total, which has no direct
   counterpart anywhere in Drew's shipped numbers — a genuinely new
   figure, not a correction of one of his.

### "103/103 letter-perfect dispatch tuples" — verified

18 (codex-5_5) + 19 (sol-5_6) + 66 (stress-2703, his "clean"/live count) =
**103**, matching his `report-addendum.md` line: "66/66 live spawns
(103/103 lifetime across three runs)." Independently verified here, not
just cross-referenced: all 103 are isolated (18/18 `fork_context: false`
+ 19/19 `fork_turns: "none"` + 66/66 `fork_turns: "none"`) **and** 100%
explicit-model (18/18 + 19/19 + 66/66). This is separate from his
`hint_honored` field (a noisier per-spawn "matched a pre-computed SDD
dispatch-table hint" flag, which sits at 17/18, 19/19, and only 27/66 for
stress — many stress spawns have `hint: null` because the auto-hint
predictor has no expectation for non-taxonomy roles, so `hint_honored`
is not the same claim as "letter-perfect" and we did not try to force
agreement between them).

### "Reviewer no-recursion" — could not locate "0/53"; report our own count instead

We searched the full corpus (`grep -rn` across every `.md`/`.json` under
`analysis/`) for a "53" figure tied to reviewers or recursion and found
none — this specific number does not appear anywhere in Drew's shipped
materials. Rather than force a match, here is what we computed directly:
across all three runs, spawns with a reviewer role
(`task_reviewer`/`fix_reviewer`/`final_reviewer`, per his own
`dispatch.json` role labels) total **64** (codex-5_5: 10, sol-5_6: 12,
stress-2703: 42). Of those 64, **zero** produced any descendant spawn —
the corpus's one and only recursive spawn (§1) was issued by an
**implementer**-role child, not a reviewer. **Reviewer no-recursion: 0/64
in this corpus**, not 0/53. The qualitative claim (reviewers don't
recurse) holds cleanly; the specific denominator named in the task brief
does not trace to any file we could find.

### E8 priors (close_agent), for context only — not scored here

Cited from his `sessions.json`/`report-addendum.md` aggregate counts only
(no raw content): codex-5_5 18/18 closed; sol-5_6 0/19; stress-2703
0/67. "Sol 0/86" (the prior named in the plan) = sol-5_6's 19 +
stress-2703's 67 children, both sol-controller runs, both 0 closed — 19 +
67 = 86, checks out. `rollout_parser.py` does not track `close_agent` at
all; this is E8's scorer to build, not attempted here.

## 4. What our parser can't measure (explicitly out of scope here)

- **78% wait-call timeout rate** (Drew's stress-run claim) requires
  pairing each `wait_agent` call with its `function_call_output` and
  classifying the outcome (timed out vs. resolved) — `rollout_parser.py`
  has no call/outcome pairing at all today. That's E7's job per
  Amendment 1; not built or attempted in this task.
- **close_agent hygiene** (E8) — not tracked by `rollout_parser.py`;
  the counts above are cited from Drew's own metrics only, not computed
  by us.
- **Workspace leaks** (E9, `.superpowers/sdd/` paths force-added past
  `.gitignore`) — requires walking run workdir git history, which we
  don't have access to for Drew's runs (his repos aren't included, per
  HANDOFF's "Not included" section) and isn't something `rollout_parser`
  does today regardless.

## 5. Concerns about our own tooling (found, not fixed, this task)

1. **`extract_spawns()`'s `fork_turns`/`task_name` fields silently read
   as `"(omitted)"` for the `multi_agent_v1` schema**, which is
   technically correct (the key really is absent) but easy to
   misinterpret as "this run has bad fork hygiene" when it's actually a
   different, still-isolated schema. Any future scorer consuming these
   fields needs a namespace/schema check before trusting `fork_turns`
   at face value, or it will silently under-report isolation on any
   corpus using this schema.
2. **`child_links()` returns an empty map for the entire corpus of
   `multi_agent_v1`-schema rollouts** (no `sub_agent_activity` event at
   all in that schema) — meaning `score_e1.py`'s child-rollout
   resolution (which depends on `child_links()`) would silently report
   zero resolved children for any battery run under this schema, not an
   error. Depth/parent attribution had to be read from `session_meta`
   directly in this task's adapter instead. Not a bug in the sense of
   wrong output — it's a real capability gap for a schema variant our
   own eval container (per Task 6b) does not currently produce, but one
   that exists in the field (Drew hit it) and that any future corpus
   ingestion should check for before trusting `child_links()`.

Neither is patched here per the task's scope; both are handed off as
findings.

## 6. What this corpus adds as treatment-arm evidence

Drew's corpus is a genuinely independent, real-world instance of the same
`codex-spinout-fixes @ bd68a949` branch our own eval container batteries
(Task 6, Task 6b) are grading — three separate sessions, two different
Codex tool schemas, one of them a 12.4-hour real interactive session with
actual compaction pressure, none of it run by us or shaped by our
scenario design. That independence is exactly what a single-lab eval
battery can't provide.

- **E1 axis A (model explicitness):** all 103 "clean" dispatches across
  both fractals runs are 100% explicit-model, corroborating our own
  CLI-0.146 re-test's finding that the field CLI version, not the
  spinout branch specifically, is what unlocks explicit model dispatch
  (our re-test found `dev`'s baseline *also* reaches 100% once CLI
  0.145+ exposes the parameter). Drew's corpus doesn't include a `dev`
  arm to compare against, so it can't by itself discriminate spinout's
  incremental contribution — but it's a second, independent data point
  showing 100% explicit-model dispatch is achievable and stable at the
  field CLI version, at real scale (66 live dispatches over 12.4 hours,
  not just a 3-4 task fixture).
- **E2 (reviewer recursion):** 0/64 reviewer-role spawns produced any
  descendant, across three independent sessions and two schemas — a
  clean corroboration of the "reviewers don't recurse by default" shape
  E2's baseline is built to check, at a much larger n than anything our
  own battery has run yet.
- **E6 (compaction recovery):** Drew's stress run is the only corpus
  evidence anywhere (ours or his) of the compaction hook firing for
  real, repeatedly, under load: 18/18 hook re-injections at root, 7 more
  inside 4 long-running child sessions, with (per his narrative,
  paraphrased, not quoted) no observed dispatch drift across any of the
  18 boundaries. His own analysis carries an explicit caveat worth
  preserving: this controller was independently well-behaved even in
  the two compaction windows with no re-read prompt at all, so the run
  demonstrates that hook + chokepoint + a compliant model together
  produce zero drift — it does not isolate the hook's own marginal
  contribution from the model's own good behavior. Treat this as strong
  supporting evidence for E6's mechanism, not as proof the hook alone
  is sufficient against a less-compliant controller.
- **E7–E9 priors:** the wait_calls (809 root, reconciling exactly to his
  805+4 split), compaction (18 root / 7 child), and close_agent (0/86
  across both sol-controller runs, 18/18 on the one codex-5_5 run)
  figures reconciled above are exactly the priors those three
  experiments need to register before building their scorers — recorded
  here and in the hypothesis log, not scored.
