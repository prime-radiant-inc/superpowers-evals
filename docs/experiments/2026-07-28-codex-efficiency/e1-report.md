# E1 fork-hygiene verdict: axis-split (baseline `dev` vs. treatment `codex-spinout-fixes`)

**Status: treatment battery complete for axis A (model-explicitness).**
Axis B (fork-isolation) was re-scoped out of E1 and into E6 by
controller adjudication (Jesse-approved) before the treatment battery
ran — see "Post-registration amendment" below and
`logs/2026-07-28-codex-efficiency.md`.

**Headline result:** axis A's literal success criterion (100% explicit
`model`) was **not met** on the treatment arm (0% explicit, identical to
baseline) — but this traces to a container infrastructure gap, not a
behavioral failure of the `codex-spinout-fixes` branch: the eval
container's installed Codex CLI is **0.144.4**, and the spinout branch's
own fix documentation explicitly gates the model/`reasoning_effort`
override on **Codex 0.145+**, saying pre-0.145 sessions correctly
inherit model with no override available. See "Critical infrastructure
finding" below.

## Post-registration amendment (axis split)

The original registered E1 prediction was compound (fork-hygiene clause
AND model-omission clause). Baseline scoring (below) showed the two
halves diverging sharply — 0% vs. 100% — rather than moving together.
Controller adjudication, approved by Jesse, split E1 into two
independently-gated axes (full text:
`logs/2026-07-28-codex-efficiency.md`, "POST-REGISTRATION AMENDMENT"
entry):

- **Axis A — model-explicitness.** Discriminates on baseline (0/34
  explicit). Proceed to treatment, scored here.
- **Axis B — fork-isolation.** Inconclusive-by-zero on this
  fresh-session scenario shape (0/34 non-isolated against a ≥40% bar).
  Re-scoped into E6, whose long-history/forced-compaction scenario is
  the corpus-supported condition for eliciting full-history forks. Not
  attempted in this report.

Before adjudicating, the controller independently re-counted the 34
baseline spawns directly against raw rollout JSON (bypassing
`score_e1.py`), confirming 34/34 `fork_turns:"none"`, 0/34 explicit
`model` — the gate result is not a scorer artifact.

## Scorer design (`score_e1.py`)

For each RUNDIR (a quorum run's coding-agent directory, one level below
`results/cx-eff-<scenario>-<arm>-repN/`):

1. Glob every `*.jsonl` under `home/.codex/sessions/**`, sorted by
   filename. Rollout filenames are `rollout-<ISO-timestamp>-<uuid>.jsonl`,
   so lexicographic filename order is chronological order; the first file
   is the root/controller rollout.
2. Call `extract_spawns()` on **every** rollout file in the run, not just
   the root — a spawned child can itself dispatch further children (a
   depth-2 fork), so limiting extraction to the root would silently drop
   those spawns.
3. For each spawn, resolve its child rollout: `child_links(parent_path)`
   maps `event_id` (== the spawn's `call_id`) to the child's
   `agent_thread_id`; the child rollout is whichever rollout filename in
   the run contains that UUID substring.
4. When a child rollout resolves, record its byte size and
   `parse_session()`'s `first_instruction_line`, `skill_reads_strict`,
   and `task_complete` (the last as the completion-parity signal).
5. Emit a markdown table (raw tuples, per run + an aggregate across all
   RUNDIRs given in one invocation) to stdout, and a JSON blob of the
   same raw data to `out/e1-<label>.json` (label auto-derived from the
   `cx-eff-<scenario>-<arm>-repN` battery-dir naming convention).

No message/instruction text is ever extracted — `extract_spawns()`'s
`Spawn` dataclass has no such field, and nothing in `score_e1.py` reads
`payload["arguments"]["message"]`. `task_name` values are fixture-derived
(`task1_implementer`, `final_reviewer`, etc.) and safe to commit
verbatim, per the task brief.

Verified against raw rollout JSON by hand on both arms (rep2 dev, rep1
spinout — `spawn_agent` function-call arguments minus the `message`
key) — the scorer's tuples match the raw data exactly on both arms.

## Baseline battery: run inventory (dev arm, `cx-sdd-small`, 4 reps)

| Rep | Run dir (leaf) | Gauntlet | Spawns | Coding cost | Gauntlet cost |
|---|---|---|---:|---:|---:|
| 1 | `cx-eff-cx-sdd-small-dev-rep1/cx-sdd-small-codex-codex_sub-linux-20260728T195835Z-c0bf` | pass | 7 | $4.14 | $0.32 |
| 2 | `cx-eff-cx-sdd-small-dev-rep2/cx-sdd-small-codex-codex_sub-linux-20260728T203056Z-de3b` | pass | 9 | $5.50 | $0.27 |
| 3 | `cx-eff-cx-sdd-small-dev-rep3/cx-sdd-small-codex-codex_sub-linux-20260728T205321Z-dad9` | pass | 9 | $5.25 | $0.25 |
| 4 | `cx-eff-cx-sdd-small-dev-rep4/cx-sdd-small-codex-codex_sub-linux-20260728T211212Z-fd5e` | pass | 9 | $4.54 | $0.33 |
| **Total** | | 4/4 pass | **34** | **$19.43** | **$1.16** |

Reps 2-4 spawned 9 (implementer+reviewer ×3 tasks, a final whole-branch
reviewer, and a fix+re-review round after the final reviewer caught a
bug); rep 1 spawned 7 (no fix round needed). rep1 was reused from the
Task 5 smoke run and predates commit `292b548` ("blind the Gauntlet
brief"); checked and confirmed **not an outlier** on any E1-relevant
metric vs. reps 2-4 (identical 100%-isolated/100%-omitted pattern) —
kept as-is, no replacement rep run.

### Baseline spawn-tuple table (all 34 spawns, every one inspected)

`child_first_instruction_line` is `None` for every row on both arms —
verified structural, not a bug: child sessions receive their task via a
`sub_agent_activity` payload, never an `event_msg/user_message` record,
and `parse_session()`'s `first_instruction_line` only fires on
`user_message` (flagged for E6, which also reads this field).

**rep1 (7 spawns)**

| call_id | task_name | fork_turns | model | reasoning_effort | child_bytes | child_skill_reads_strict | child_task_complete |
|---|---|---|---|---|---:|---:|---:|
| call_8x3CT29ZJiZeNqm0WQ7kW2Jh | task1_implementer | none | (omitted) | (omitted) | 152069 | 1 | 1 |
| call_65rPEzIHVjbkwlnRezsdo5C7 | task1_reviewer | none | (omitted) | (omitted) | 77764 | 1 | 1 |
| call_TlUSM25CSlzBLsfLuWe4nQJ8 | task2_implementer | none | (omitted) | (omitted) | 181695 | 2 | 1 |
| call_jCgHJVulItUk1sijCazz1AZc | task2_reviewer | none | (omitted) | (omitted) | 92343 | 1 | 1 |
| call_eQU8hoyzV7cJ4WkrXNXdJPgy | task3_implementer | none | (omitted) | (omitted) | 151052 | 3 | 1 |
| call_9Q9WoPBlbXPMZ7KDslsZ7o9S | task3_reviewer | none | (omitted) | (omitted) | 75338 | 1 | 1 |
| call_FxvIHBTQXWEIJZMznmkfZV8i | final_reviewer | none | (omitted) | (omitted) | 94511 | 1 | 1 |

**rep2 (9 spawns)**

| call_id | task_name | fork_turns | model | reasoning_effort | child_bytes | child_skill_reads_strict | child_task_complete |
|---|---|---|---|---|---:|---:|---:|
| call_WUQPVD1fPVPboSHo8rqMqv5D | task1_implementer | none | (omitted) | (omitted) | 152247 | 2 | 1 |
| call_m5ALoXKAIsXgyQtwGpebWHAF | task1_reviewer | none | (omitted) | (omitted) | 83177 | 1 | 1 |
| call_8E53ZWLcFo0tCEAP1Xfhbmhb | task2_implementer | none | (omitted) | (omitted) | 163750 | 2 | 1 |
| call_xops09CD6BXLcAxXGsdTkbqe | task2_reviewer | none | (omitted) | (omitted) | 91093 | 1 | 1 |
| call_BU4kYPSzCOByhf5BpkMdA7Wu | task3_implementer | none | (omitted) | (omitted) | 179283 | 3 | 1 |
| call_g2b1Ckl7MM4ObG3pLpKBVmBU | task3_reviewer | none | (omitted) | (omitted) | 89178 | 1 | 1 |
| call_Ck6d3NqnNRUbUCWinjAJX7Ey | final_reviewer | none | (omitted) | (omitted) | 109196 | 1 | 1 |
| call_CtiYRy4aK4uIdf4ZXRLv3xW9 | final_fixer | none | (omitted) | (omitted) | 145615 | 2 | 1 |
| call_8AL5mbu1swL7bixBEnFmuP4O | final_rereviewer | none | (omitted) | (omitted) | 89681 | 1 | 1 |

**rep3 (9 spawns)**

| call_id | task_name | fork_turns | model | reasoning_effort | child_bytes | child_skill_reads_strict | child_task_complete |
|---|---|---|---|---|---:|---:|---:|
| call_kSBQHsxTfk0g5ZivjrHQhun0 | task1_implementer | none | (omitted) | (omitted) | 135914 | 2 | 1 |
| call_FdDW0qHnn0aADFthYHUN8Glz | task1_reviewer | none | (omitted) | (omitted) | 79151 | 1 | 1 |
| call_7zisjmoLsGI0Mor7e0KsrF5g | task2_implementer | none | (omitted) | (omitted) | 179954 | 2 | 1 |
| call_R6B3MVmUgbeC7lQ9nG2ddd6d | task2_reviewer | none | (omitted) | (omitted) | 83846 | 1 | 1 |
| call_BwTMep0mGYoS5kQDBxlTc0LC | task3_implementer | none | (omitted) | (omitted) | 127825 | 2 | 1 |
| call_8VFSyGp19dYXyAXMWblUUMlE | task3_reviewer | none | (omitted) | (omitted) | 76939 | 1 | 1 |
| call_NcxhMIaR39QvAVKm88WkEqJ6 | final_reviewer | none | (omitted) | (omitted) | 122846 | 1 | 1 |
| call_bEiWZSfwlBu29UD4oTSUoCPK | final_fix | none | (omitted) | (omitted) | 159696 | 2 | 1 |
| call_vFLo8ceSu02qfYt67ttzfNkK | final_fix_reviewer | none | (omitted) | (omitted) | 76548 | 1 | 1 |

**rep4 (9 spawns)**

| call_id | task_name | fork_turns | model | reasoning_effort | child_bytes | child_skill_reads_strict | child_task_complete |
|---|---|---|---|---|---:|---:|---:|
| call_JkBrbwNj3XkuIbaaqQBtgH7s | task1_implementer | none | (omitted) | (omitted) | 157074 | 1 | 1 |
| call_fXgNkKDNzHfaYW7Pkb0Fk07T | task1_reviewer | none | (omitted) | (omitted) | 78953 | 1 | 1 |
| call_pjBCbggjHFKZX3LDTIpCOz1p | task2_implementer | none | (omitted) | (omitted) | 164357 | 2 | 1 |
| call_y1LxnfCBoRsHoYOM4tCmcTe2 | task2_reviewer | none | (omitted) | (omitted) | 84918 | 1 | 1 |
| call_nYq8AGzZDv2wQ04VGaSk8ej6 | task3_implementer | none | (omitted) | (omitted) | 145159 | 2 | 1 |
| call_17eXWMcv5uYFIozW9TmHEdhe | task3_reviewer | none | (omitted) | (omitted) | 80254 | 1 | 1 |
| call_GusxjXAwfvsdV7PDXqseROPS | final_reviewer | none | (omitted) | (omitted) | 102501 | 1 | 1 |
| call_alespbPXOFuxOK4Uz3V0cnhw | final_fix | none | (omitted) | (omitted) | 169274 | 2 | 1 |
| call_xrgH4bYezcZR4Y1TDtbkLwgu | final_fix_reviewer | none | (omitted) | (omitted) | 75860 | 1 | 1 |

**Baseline aggregate (34/34 spawns):** 100% isolated, 0% `"all"`/partial,
0% explicit model, 100% model-omitted, 100% child-resolved, 100% child
`task_complete`. Identical across all 4 reps individually.

## Treatment battery: run inventory (spinout arm, `cx-sdd-small`, 4 reps)

| Rep | Run dir (leaf) | Gauntlet | Spawns | Coding cost | Gauntlet cost |
|---|---|---|---:|---:|---:|
| 1 | `cx-eff-cx-sdd-small-spinout-rep1/cx-sdd-small-codex-codex_sub-linux-20260729T031843Z-7b72` | pass | 9 | $5.06 | $0.37 |
| 2 | `cx-eff-cx-sdd-small-spinout-rep2/cx-sdd-small-codex-codex_sub-linux-20260729T033825Z-d4dc` | pass | 9 | $4.76 | $0.34 |
| 3 | `cx-eff-cx-sdd-small-spinout-rep3/cx-sdd-small-codex-codex_sub-linux-20260729T035556Z-637b` | pass | 9 | $6.40 | $0.37 |
| 4 | `cx-eff-cx-sdd-small-spinout-rep4/cx-sdd-small-codex-codex_sub-linux-20260729T041642Z-1878` | pass | 7 | $3.69 | $0.31 |
| **Total** | | 4/4 pass | **34** | **$19.90** | **$1.38** |

Run via `bash run-quorum.sh spinout cx-sdd-small 4` (the `REP_START`
mechanism wasn't needed here — spinout had no pre-existing reps, so the
default `REP_START=1` covers all 4). Sequential, one quorum run at a
time, ~13-21 min wall each.

### Treatment spawn-tuple table (all 34 spawns, every one inspected)

**rep1 (9 spawns)**

| call_id | task_name | fork_turns | model | reasoning_effort | child_bytes | child_skill_reads_strict | child_task_complete |
|---|---|---|---|---|---:|---:|---:|
| call_jU6cuztdAmf6xtEWzLvYVTMS | task1_implementer | none | (omitted) | (omitted) | 155509 | 1 | 1 |
| call_vfg5Hxkg8ab6K9FDRCNlMeFz | task1_reviewer | none | (omitted) | (omitted) | 82801 | 1 | 1 |
| call_XgYU5iUe7P2C4UbNQWdhZlRI | task2_implementer | none | (omitted) | (omitted) | 177573 | 1 | 1 |
| call_187gbG43n1ag6XYDWix8mtSQ | task2_reviewer | none | (omitted) | (omitted) | 89694 | 1 | 1 |
| call_A0EGFZif4Xvo8t42rmWnKaxZ | task3_implementer | none | (omitted) | (omitted) | 138514 | 2 | 1 |
| call_f92CDgb011RmI6zXHX6tnYgW | task3_reviewer | none | (omitted) | (omitted) | 79559 | 1 | 1 |
| call_JRH7redWS3nRpyZu3eFn6N18 | final_reviewer | none | (omitted) | (omitted) | 122038 | 1 | 1 |
| call_KrMAgvTcE06pQdAg5DavT7j9 | final_fix_implementer | none | (omitted) | (omitted) | 167837 | 2 | 1 |
| call_HaNhfFN6Cw0sACjrv5NRUEqv | final_fix_reviewer | none | (omitted) | (omitted) | 84448 | 1 | 1 |

**rep2 (9 spawns)**

| call_id | task_name | fork_turns | model | reasoning_effort | child_bytes | child_skill_reads_strict | child_task_complete |
|---|---|---|---|---|---:|---:|---:|
| call_nDMOg2nWc4TR1ffmAnRJZxIx | task1_implementer | none | (omitted) | (omitted) | 154941 | 1 | 1 |
| call_cFMWvPgj6Zw9GA3poi77zaGQ | task1_reviewer | none | (omitted) | (omitted) | 81978 | 1 | 1 |
| call_6AF7HrKYXTQ74Bz9FGunsaWD | task2_implementer | none | (omitted) | (omitted) | 151993 | 1 | 1 |
| call_RzMRmFJVEfeta4na1epqZdmM | task2_reviewer | none | (omitted) | (omitted) | 79344 | 1 | 1 |
| call_JhhEAVMhbY3GzmyBuf91vijN | task3_implementer | none | (omitted) | (omitted) | 148426 | 2 | 1 |
| call_FSvRy3Kc7CwnyksREy2OvpE5 | task3_reviewer | none | (omitted) | (omitted) | 76483 | 1 | 1 |
| call_yLDr7LzOXU6LI7xvPDCmZeEh | final_reviewer | none | (omitted) | (omitted) | 99157 | 1 | 1 |
| call_hYHWemUKXA2vKXfsEWZvUoj4 | final_fix | none | (omitted) | (omitted) | 151630 | 2 | 1 |
| call_fWSnjQn9tJpWtVb3Lz2Q4QgH | final_fix_reviewer | none | (omitted) | (omitted) | 99273 | 1 | 1 |

**rep3 (9 spawns)**

| call_id | task_name | fork_turns | model | reasoning_effort | child_bytes | child_skill_reads_strict | child_task_complete |
|---|---|---|---|---|---:|---:|---:|
| call_3UvqwQR3cJGwNVK5KatLU6Gn | task1_implementer | none | (omitted) | (omitted) | 148744 | 1 | 1 |
| call_cp7T9LxDVmwFi2bUF6rv35k2 | task1_reviewer | none | (omitted) | (omitted) | 88228 | 1 | 1 |
| call_c9VGUTMLUTrOheDfIouFt35L | task2_implementer | none | (omitted) | (omitted) | 159493 | 1 | 1 |
| call_PjgPnaKUVAGNrzQYuGAo7oi1 | task2_reviewer | none | (omitted) | (omitted) | 91281 | 1 | 1 |
| call_CvTOpuROH6CAyWFJJPxwbHUu | task3_implementer | none | (omitted) | (omitted) | 165649 | 4 | 1 |
| call_IJMIYzzwepwXq6APJldV266t | task3_reviewer | none | (omitted) | (omitted) | 96404 | 1 | 1 |
| call_UPjQPlIxcmB7RgHLlIwtk3bO | final_reviewer | none | (omitted) | (omitted) | 136809 | 1 | 1 |
| call_62RkXZRdgFr6NB2ocGISVEJS | final_fix_implementer | none | (omitted) | (omitted) | 211903 | 2 | 2 |
| call_pHssWjWsNcBfh2PepiSB46YK | final_fix_reviewer | none | (omitted) | (omitted) | 96107 | 1 | 1 |

**rep4 (7 spawns)**

| call_id | task_name | fork_turns | model | reasoning_effort | child_bytes | child_skill_reads_strict | child_task_complete |
|---|---|---|---|---|---:|---:|---:|
| call_lhZPAlML3h0MrAqOr4pb7YAH | task1_implementer | none | (omitted) | (omitted) | 136057 | 1 | 1 |
| call_P6MYZXmyPZYKwUjVkEH46mHI | task1_reviewer | none | (omitted) | (omitted) | 83112 | 1 | 1 |
| call_RVHGMWr34Q3KRsUVdIJFyTVg | task2_implementer | none | (omitted) | (omitted) | 167522 | 1 | 1 |
| call_8oproGuBeNsSZxnjQlzRT65e | task2_reviewer | none | (omitted) | (omitted) | 98035 | 1 | 1 |
| call_sj2Gn5yymrD31fVMH80TVul0 | task3_implementer | none | (omitted) | (omitted) | 148539 | 2 | 1 |
| call_i9H0YaV4G12xYHDvgPzafsld | task3_reviewer | none | (omitted) | (omitted) | 94352 | 1 | 1 |
| call_YDnKj2mPl8TQSGBRrNJmFgNf | final_reviewer | none | (omitted) | (omitted) | 101840 | 1 | 1 |

**Treatment aggregate (34/34 spawns):** 100% isolated, 0% `"all"`/partial,
0% explicit model, 100% model-omitted, 100% child-resolved, 100% child
`task_complete`. **Bit-identical distribution to baseline on every
metric.**

## Combined aggregate (both arms, 68 spawns)

| Metric | dev (baseline) | spinout (treatment) |
|---|---:|---:|
| spawns | 34 | 34 |
| isolated (`fork_turns:"none"`) | 100.0% | 100.0% |
| `fork_turns:"all"` or partial | 0.0% | 0.0% |
| explicit model | 0.0% | 0.0% |
| model omitted | 100.0% | 100.0% |
| child rollout resolved | 100.0% | 100.0% |
| child `task_complete` present | 100.0% | 100.0% |

**Fork_turns regression check (secondary readout):** no regression —
treatment stayed at 100% `"none"`, matching the expectation stated in
the axis-split decision.

**Completion parity:** full parity — 34/34 children reached
`task_complete` on both arms.

## Critical infrastructure finding: Codex CLI version gates axis A

`session_meta.cli_version` was read directly from the controller
rollout of every one of the 8 runs (both arms, all reps):
**`0.144.4`, unanimously.** This is the actual installed Codex CLI in
the eval container — the arm only changes which superpowers checkout is
mounted (`/tmp/sp-arm-dev` vs. `/tmp/sp-arm-spinout`), not the container
image or its `codex` binary.

The spinout branch's own
`skills/using-superpowers/references/codex-tools.md` (read directly off
`/tmp/sp-arm-spinout`) says, verbatim:

> If your `spawn_agent` schema has `model` and `reasoning_effort`
> parameters (Codex 0.145+), set both on every dispatch: task-brief and
> review-package print a `dispatch:` hint line with the exact values...
>
> Without those parameters (Codex 0.144 and earlier), children inherit
> your model and effort with no override... Tell your human partner
> before starting a plan of more than a few tasks, and offer a
> lower-effort session instead.

**The container's Codex CLI (0.144.4) is exactly the "0.144 and
earlier" case the fix's own documentation calls out.** Per the branch's
own conditional logic, there is no `model`/`reasoning_effort` parameter
on `spawn_agent` to set in this environment, and inheriting model with
no override is the *documented-correct* behavior — not a fix failure.
This is consistent with the observed 0% explicit-model rate being
bit-identical between baseline and treatment: axis A literally cannot be
exercised by this eval container as currently provisioned.

**This was not independently confirmed via the raw tool schema** (the
rollout JSONL logs conversation content, not the API request's tool
definitions) — the finding rests on (a) the branch's own documented
version gate, (b) the container's confirmed `cli_version`, and (c) the
observed behavior being identical across both arms despite the fix
being present only on `codex-spinout-fixes`. All three point the same
direction, but a direct check of the container's actual `spawn_agent`
tool schema would make this conclusive rather than well-supported.

## Axis A verdict: success criterion NOT MET, root-caused to CLI version

Success criterion (controller): 100% explicit `model` on SDD spawns,
task completion parity.

| | Baseline | Treatment | Target |
|---|---:|---:|---:|
| Explicit model | 0.0% | 0.0% | 100% |
| Task-completion parity | 100% (34/34) | 100% (34/34) | preserved |

**The literal criterion fails** — treatment shows no improvement over
baseline on model-explicitness. **Root cause, per the evidence above: an
eval-container infrastructure gap (Codex CLI 0.144.4 < the fix's 0.145+
requirement), not a `codex-spinout-fixes` design or skill-content
failure.** Task-completion parity holds cleanly.

**Recommendation for the controller:** re-run this treatment battery
(or a smaller MICRO check) against a container image with Codex CLI
≥0.145 before drawing any conclusion about whether the spinout branch's
model-explicitness fix works — the current battery cannot discriminate
that question. Until then, axis A is **inconclusive, not failed**.

## Axis B: fork-isolation — re-scoped to E6, not evaluated here

Per the post-registration amendment, axis B is out of scope for this
report. Both arms show 100% isolated forks (0% "all"/partial) on this
fresh-session scenario shape, consistent with the earlier
inconclusive-by-zero baseline finding — E6's long-history/
forced-compaction scenario remains the intended vehicle for eliciting
and scoring full-history forking.

## Cost / budget

| Battery | Coding | Gauntlet | Total |
|---|---:|---:|---:|
| Baseline (dev, 4 reps) | $19.43 | $1.16 | $20.59 |
| Treatment (spinout, 4 reps) | $19.90 | $1.38 | $21.28 |
| **E1 total (both batteries)** | **$39.33** | **$2.54** | **$41.87** |

Subscription `used_percent` (`rate_limits.primary.used_percent`, last
`token_count` event of the controller rollout):

- Baseline: 28.0% (rep1) → 31.0% (rep4).
- Treatment: 45.0% (rep1) → 1.0% (rep4) — a rate-limit window rollover
  occurred between the treatment reps (the raw drop is reported as
  observed, not adjusted; not a budget anomaly — the primary window is
  `window_minutes: 10080`, i.e. 7 days, so a reset mid-battery is
  plausible and not investigated further here).

See `logs/2026-07-28-codex-efficiency.md` budget ledger for both rows
and the campaign-running total.

## Deviations from the brief / addendum instructions

1. **Axis split via post-registration amendment**, not a straight
   baseline→treatment pass — recorded in the hypothesis log per the
   controller's explicit instruction, with independent verification
   noted (controller re-counted 34/34 fork-none, 0/34 model via raw
   grep before adjudicating).
2. **Axis A's literal success criterion fails**, but the report
   root-causes this to the eval container's Codex CLI version rather
   than presenting it as a clean negative result — the fix's own
   documentation names the exact version gate the container falls
   below.
3. **`run-quorum.sh`'s `REP_START` arg** (added for the baseline
   battery) wasn't needed for the treatment battery since spinout had no
   pre-existing reps; used the plain 3-arg form.
4. Polled the treatment battery with long-timeout blocking loops inside
   the session (per the controller's explicit instruction) rather than
   an external Monitor task.
5. As with baseline, no message/instruction text was extracted or
   printed anywhere in this report or its JSON blobs — only
   fixture-derived `task_name` labels and technical metadata.
