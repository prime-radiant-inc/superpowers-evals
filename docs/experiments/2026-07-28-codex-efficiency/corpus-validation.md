# Corpus validation: rollout_parser vs the 2026-07-28 audit ground truth

Ran via `campaigns/codex-efficiency/validate_corpus.py` against
`AUDIT_DIR=/Users/jesse/.codex/visualizations/2026/07/28/019fa9a2-87b7-73b1-a76a-efb9f14abbea`.
Full output (may quote real client commands) went to
`out/corpus-validation-raw.txt`, which is gitignored and was **not**
committed. This file records aggregates and mismatch categories only.

## Phase A: spawn parity (exact)

`spawns-window.json` (1,098 spawn records across 161 distinct sessions) vs
`extract_spawns()`, window-filtered to `[2026-07-14T07:00:00.000Z,
2026-07-28T16:50:29.164Z)` per the brief.

- Sessions compared: 161 / 161 (0 missing rollout files)
- Exact-match sessions: **161 / 161 (100%)**
- Mismatches: 0
- Aggregate `fork_turns` distribution (ours vs audit): identical —
  `all`=574, `none`=359, `(omitted)`=18, and the same numeric-partial tail
  (`2`=12, `3`=81, `4`=34, `5`=14, `6`=5, `8`=1). Matches the pre-registered
  expected distribution exactly.
- Aggregate `model` omission count (ours vs audit): identical — 925 / 1098
  omitted on both sides.

**Verdict: exact parity, as required.** No parser changes were needed.

## Phase B: per-session metrics (stratified ~60-session sample)

Sample: 10 largest by `bytes`, 10 with `oversized_lines > 0`, 10 with
`context_compacted > 0`, 10 with `spawn_calls > 0` (each bucket sorted
descending by its own defining count, ties broken by bytes), 20 random
(`random.Random(42)` over the full 2,240-session population, independent of
the other buckets). After de-duplication across buckets: **49 distinct
sessions**, 0 missing rollout files.

| Field (ours → audit) | Exact matches | Rate |
|---|---|---|
| `compactions` → `context_compacted` | 46/49 | 93.9% |
| `task_started` → `task_started` | 46/49 | 93.9% |
| `task_complete` → `task_complete` | 46/49 | 93.9% |
| `skill_reads_compat` → `skill_reads` | 46/49 | 93.9% |
| `memory_reads` → `memory_reads` | 46/49 | 93.9% |
| `spawn_calls` → `spawn_calls` | 48/49 | 98.0% |
| `wait_calls` → `wait_calls` | 46/49 | 93.9% |
| `test_commands` → `test_command_calls` | 46/49 | 93.9% |

All 22 field-level mismatches (out of 49 × 8 = 392 comparisons) trace to
exactly **3 of the 49 sampled sessions**. The other 46 sessions (93.9%) are
byte-for-byte exact matches across all 8 fields simultaneously — this is not
8 independent ~94% rates, it's one clean population split.

### Mismatch category: parser has no audit-window filter

**Cause, confirmed by direct rollout inspection on two of the three
sessions:** the audit's scanner discards every line whose timestamp falls
outside `[2026-07-14T07:00:00.000Z, 2026-07-28T16:50:29.164Z)` *before*
incrementing any counter — so `context_compacted`, `task_started`,
`task_complete`, `skill_reads`, `memory_reads`, `spawn_calls`, `wait_calls`,
and `test_command_calls` in `metrics-all.jsonl` are all windowed counts.
`rollout_parser.parse_session()` has no such filter (Tasks 2–3 never
required one) and counts the entire file. The two mechanisms observed:

1. **Pre-window activity.** A session created before the window start whose
   conversation continues into the window has its early portion (verified:
   thousands of lines, tens of `task_started` events) counted by us but
   excluded by the audit. Manifest-wide, 9 of 2,240 sessions were created
   before window start; 2 of the 3 mismatching sessions in this sample are
   in that set, and one concrete case's `task_started` delta (32) matched
   exactly the number of `task_started` events found before the window
   start when the rollout was read directly.
2. **Post-window (live) activity.** One sampled session's rollout file was
   still actively growing at validation time — a Codex session that is
   still running past the moment the audit snapshot was taken. Its
   post-window line count and post-window `task_started` count (verified by
   direct read) matched its mismatch deltas exactly. Manifest-wide, only 1
   of 2,240 sessions had this property at audit time, but any run of this
   validator on a live corpus can pick up a different such session (the
   *identity* of which session is affected is not fully reproducible
   run-to-run for this one bucket, even though the sampling of *which
   sessions* to check is seeded).

Both mechanisms are the same root cause (no window filter in
`parse_session`), not two separate bugs, and not a parser defect — Tasks 2–3
were never scoped to window-filter. No `rollout_parser.py` change was made
in this task per the brief's instruction; see Concerns below.

### Restriction for downstream scorers

**Downstream scorers must not treat `parse_session()`'s absolute counts as
corpus-comparable ground truth for a session whose rollout activity extends
outside `[2026-07-14T07:00:00.000Z, 2026-07-28T16:50:29.164Z)`** — i.e. any
session created before window start, or still live/growing past window end.
For sessions fully inside the window (the large majority: 2,231/2,240 by
creation time, 2,239/2,240 by last-update time in this corpus), all 8 fields
are exact-parity verified (46/46 = 100% in this sample). A scorer that needs
window-scoped counts for a boundary-spanning session must pre-filter lines
by timestamp itself; `parse_session()` does not do this.

## Phase C: manual-inspection feed

Sampled matched skill-read commands (from sessions with `skill_reads > 0`)
and matched test commands (from sessions with `test_command_calls > 0`),
truncated to 160 chars, `random.Random(42)`-selected. Eyeballed by hand
(cannot be reproduced here — output is real client command text, which is
exactly why the raw file isn't committed).

**What was observed:** every sampled skill-read match was a genuine shell
read of a `SKILL.md` file (`cat`/`sed -n` piped through the file path) —
no false positives in this sample. Every sampled test-command match was a
genuine test-runner invocation (`pytest`, `go test`, `xcodebuild test`, and
similar) — no false positives in this sample. This is consistent with, and
does not change, the already-documented `skill_reads_compat` caveat from
Task 3: the classifier also fires on `apply_patch` payloads that merely
*mention* a `SKILL.md` path (a known audit-scanner false-positive this
sample didn't happen to surface, since it drew from real exec-shaped reads).

## Overall verdict

- **Phase A: exact parity, unconditionally trusted.**
- **Phase B: exact parity for any session fully inside the audit window;
  outside that window, the parser is a superset (counts include out-of-window
  activity the audit excludes) — a documented, understood restriction, not a
  defect.** Per-field rates land at 93.9–98.0% only because 3 of the 49
  sampled sessions straddle the window boundary; restricting to in-window
  sessions gives 100% (46/46) on every field.
- **Phase C: classifiers behave as intended on real data**, no false
  positives observed in the sampled matches.

The parser is trusted for corpus-relative scoring **subject to the Phase B
restriction above** (see task-4-report.md Concerns for the one suggested
future parser enhancement, not implemented in this task).
