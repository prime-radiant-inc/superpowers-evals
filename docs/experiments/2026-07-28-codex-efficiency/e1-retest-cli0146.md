# E1 re-test at Codex CLI 0.146.0 (Task 6b)

Task 6 (2026-07-28) scored E1 baseline (dev, 4 reps) and axis-A treatment
(spinout, 4 reps) entirely on an eval container pinned to Codex CLI
`0.144.4` — below the `codex-spinout-fixes` branch's own documented
0.145+ gate for the `model`/`reasoning_effort` `spawn_agent` parameters
to exist at all. Both arms came back bit-identical (0% explicit model),
root-caused to that infrastructure gap rather than a behavioral
difference. This task bumps the container's pinned Codex CLI to
`0.146.0` and re-runs a smaller confirmatory battery: **2 new baseline
reps** (dev arm, rep5-6) and **4 new treatment reps** (spinout arm,
rep5-8) — extending the existing `cx-sdd-small` batteries via
`run-quorum.sh`'s `REP_START` offset rather than replacing rep1-4.

**Container change:** `evals/container/Dockerfile` bumped
`@openai/codex@0.144.4` -> `@openai/codex@0.146.0` (0.146.0 is the
newest published exact-version release on npm as of this run; several
`0.146.0-alpha.N` prereleases exist but 0.146.0 itself is out). Local
commit only in the `evals` checkout, not pushed (per task instructions):
commit `6266ced`.

**Headline result:** the container bump landed cleanly (`codex --version`
-> `codex-cli 0.146.0`, confirmed independently per-rep below via
`session_meta.cli_version`). The baseline confound holds — fork_turns
stays 100% `"none"` at the new CLI, no regression. But axis A's own
story changed underneath it: **baseline (dev arm) now also shows 100%
explicit model** (14/14), not just treatment. This traces to a
pre-existing instruction in `dev`'s own
`subagent-driven-development/SKILL.md` ("Always specify the model
explicitly when dispatching a subagent," unrelated to the spinout
branch) that simply had no `model` parameter to act on before 0.145 —
once the CLI unlocks the parameter, both arms use it. Treatment's
literal 100%-explicit-model criterion is not fully met (93.9%, 31/33) —
but the 2 misses are structurally distinct from the rest: both are
**depth-2 spawns issued by an implementer child**, not by the root
controller. Every root-controller spawn on both arms (45/45) is
explicit-model. Full detail below.

## CLI-version evidence (per new rep, `session_meta.cli_version`)

Read directly off byte 1 of each rep's root controller rollout
(`type: "session_meta"`, `payload.cli_version`) — the same field and
method Task 6's addendum used to establish the `0.144.4` root cause.

| Arm | Rep | Run dir (leaf) | `cli_version` |
|---|---:|---|---|
| dev | 5 | `cx-eff-cx-sdd-small-dev-rep5/cx-sdd-small-codex-codex_sub-linux-20260729T050129Z-4e24` | `0.146.0` |
| dev | 6 | `cx-eff-cx-sdd-small-dev-rep6/cx-sdd-small-codex-codex_sub-linux-20260729T051838Z-1912` | `0.146.0` |
| spinout | 5 | `cx-eff-cx-sdd-small-spinout-rep5/cx-sdd-small-codex-codex_sub-linux-20260729T053429Z-3ac1` | `0.146.0` |
| spinout | 6 | `cx-eff-cx-sdd-small-spinout-rep6/cx-sdd-small-codex-codex_sub-linux-20260729T055537Z-e62f` | `0.146.0` |
| spinout | 7 | `cx-eff-cx-sdd-small-spinout-rep7/cx-sdd-small-codex-codex_sub-linux-20260729T061915Z-19d1` | `0.146.0` |
| spinout | 8 | `cx-eff-cx-sdd-small-spinout-rep8/cx-sdd-small-codex-codex_sub-linux-20260729T064125Z-f70d` | `0.146.0` |

6/6 new reps confirmed `0.146.0`, unanimously above the branch's own
0.145+ gate. Also confirmed via a direct in-container probe before
spending anything: `scripts/evals-container exec codex --version` ->
`codex-cli 0.146.0`.

Both arm worktrees (`/tmp/sp-arm-dev` @ `bb2a34b`, `/tmp/sp-arm-spinout`
@ `bd68a94`) are unchanged since Task 6 — same commits, same scenario
fixture — so this re-test isolates the CLI-version variable cleanly with
no confounding skill-content drift.

## Battery run inventory

### Baseline (dev arm, `cx-sdd-small`, 2 new reps)

| Rep | Run dir (leaf) | Gauntlet | Spawns | Coding cost | Gauntlet cost | Total |
|---|---|---|---:|---:|---:|---:|
| 5 | `cx-eff-cx-sdd-small-dev-rep5/...-4e24` | pass | 7 | $3.05 | $0.33 | $3.38 |
| 6 | `cx-eff-cx-sdd-small-dev-rep6/...-1912` | pass | 7 | $3.59 | $0.30 | $3.89 |
| **Total** | | 2/2 pass | **14** | **$6.64** | **$0.63** | **$7.27** |

Run via `bash run-quorum.sh dev cx-sdd-small 2 5` (extends Task 6's
rep1-4 baseline; rep1-4 untouched, still on disk, still `0.144.4`).

### Treatment (spinout arm, `cx-sdd-small`, 4 new reps, axis A)

| Rep | Run dir (leaf) | Gauntlet | Spawns | Coding cost | Gauntlet cost | Total |
|---|---|---:|---:|---:|---:|---:|
| 5 | `cx-eff-cx-sdd-small-spinout-rep5/...-3ac1` | pass | 8 | $4.21 | $0.31 | $4.52 |
| 6 | `cx-eff-cx-sdd-small-spinout-rep6/...-e62f` | pass | 7 | $4.22 | $0.32 | $4.54 |
| 7 | `cx-eff-cx-sdd-small-spinout-rep7/...-19d1` | pass | 9 | $4.39 | $0.33 | $4.72 |
| 8 | `cx-eff-cx-sdd-small-spinout-rep8/...-f70d` | pass | 9 | $3.61 | $0.35 | $3.96 |
| **Total** | | 4/4 pass | **33** | **$16.42** | **$1.31** | **$17.74** |

Run via `bash run-quorum.sh spinout cx-sdd-small 4 5` (extends Task 6's
rep1-4 treatment). All 6 new reps (both arms) gauntlet-passed; 6/6.

**Grand total, this task: $25.01** (against the plan's ≈$32 estimate).

**Minor deviation, noted not investigated:**
`results/cx-eff-cx-sdd-small-spinout-rep6/` contains a second, empty
sibling directory (`cx-eff-cx-sdd-small-codex-codex_sub-linux-20260729T055537Z-e62f/`,
0 bytes, two empty subdirectories under `coding-agent-workdir/.worktrees/strutils/`,
no `verdict.json`, no session logs) alongside the real scored run dir
(`cx-sdd-small-codex-codex_sub-linux-20260729T055537Z-e62f/`, same
timestamp+hash suffix). quorum's own run log only ever reports the
latter as the run-dir; the empty sibling was never part of the scored
run, contributes no cost, and is not committed (nothing under
`evals/results/` ever is). Flagged for whoever next touches
`run-quorum.sh`'s staging path, not chased further here.

## Spawn-tuple tables — all 47 new spawns, every one inspected

`child_first_instruction_line` omitted from the printed tables below
(same structural reason as Task 6: always `None`, see `out/e1-report.md`).
Full raw tuples (including that field) are in the JSON artifacts.

### Baseline, dev arm

**rep5 (7 spawns)**

| call_id | task_name | fork_turns | model | reasoning_effort | child_bytes | child_skill_reads_strict | child_task_complete |
|---|---|---|---|---|---:|---:|---:|
| call_TUm2evDbUFezxfQ2qwK3NMGQ | task1_implementer | none | gpt-5.6-terra | medium | 211200 | 2 | 1 |
| call_2YjLCKGtrIdFT0gt9r04PCR5 | task1_reviewer | none | gpt-5.6-terra | medium | 95374 | 1 | 1 |
| call_K81HNeucQLclEQbkwbrnHsMW | task2_implementer | none | gpt-5.6-terra | medium | 191157 | 4 | 1 |
| call_70ntEApMrWyuxZuZijU0X8yW | task2_reviewer | none | gpt-5.6-terra | medium | 89298 | 1 | 1 |
| call_hoE2SiMNCO7wQ8ni2Jquoaxj | task3_implementer | none | gpt-5.6-terra | medium | 190872 | 1 | 1 |
| call_V9pQD3Vs74nWHFkstUhzHkiJ | task3_reviewer | none | gpt-5.6-terra | medium | 89456 | 1 | 1 |
| call_oxkpGBKkvW43FAc5VIl4Z8B2 | final_reviewer | none | gpt-5.6-sol | xhigh | 113899 | 1 | 1 |

**rep6 (7 spawns)**

| call_id | task_name | fork_turns | model | reasoning_effort | child_bytes | child_skill_reads_strict | child_task_complete |
|---|---|---|---|---|---:|---:|---:|
| call_J76T9YlkCKHbycAUxVN9KEfn | task1_implementer | none | gpt-5.6-terra | low | 171272 | 1 | 1 |
| call_DwngU7O4bIJjm84393Hqo5OY | task1_reviewer | none | gpt-5.6-terra | medium | 90410 | 1 | 1 |
| call_kFyaENa3XRN8XksU5neQA8iI | task2_implementer | none | gpt-5.6-terra | low | 168310 | 1 | 1 |
| call_Goss4MWKVwuVAD0rYNRRNkek | task2_reviewer | none | gpt-5.6-terra | medium | 95410 | 1 | 1 |
| call_6F2SxKSRltdyYw4V3ORJ8OIU | task3_implementer | none | gpt-5.6-terra | low | 160099 | 1 | 1 |
| call_2gmJdkola6KEWklNa71SymtB | task3_reviewer | none | gpt-5.6-terra | medium | 94010 | 1 | 1 |
| call_NEGCSQMK4ulcGqn5xiFBRss0 | final_reviewer | none | gpt-5.6-sol | xhigh | 149052 | 1 | 1 |

**Baseline aggregate (14/14 spawns):** 100% isolated (`fork_turns:"none"`),
0% `"all"`/partial, **100% explicit model**, 0% model-omitted, 100%
child-resolved, 100% child `task_complete`. All 14 spawns issued
directly by the root controller (no depth-2 forking observed).

### Treatment, spinout arm

**rep5 (8 spawns)**

| call_id | task_name | fork_turns | model | reasoning_effort | child_bytes | child_skill_reads_strict | child_task_complete |
|---|---|---|---|---|---:|---:|---:|
| call_Eo0ibBcFfBUx2DLVfYGiH7El | task1_implementer | none | gpt-5.6-terra | high | 172296 | 1 | 1 |
| call_KyLart3Ft16L658ha3SFr5pj | task1_reviewer | none | gpt-5.6-terra | high | 101317 | 1 | 1 |
| call_QWutAwPG9iAl7vm2bWyKfCFt | task2_implementer | none | gpt-5.6-terra | high | 240574 | 2 | 1 |
| call_NIqRrkd1J8jyS8wXqySSdU8J | task2_reviewer | none | gpt-5.6-terra | high | 111583 | 1 | 1 |
| call_wGN8NDEhACd0Twhjn4HUrMwJ | task3_implementer | none | gpt-5.6-terra | high | 184628 | 2 | 1 |
| call_UM1BHAdwKir0L5ce7cpQapLa | task3_reviewer | none | gpt-5.6-terra | high | 112965 | 1 | 1 |
| call_JKMltVkACHFvU3bc8JMTQel4 | final_reviewer | none | gpt-5.6-sol | ultra | 180454 | 3 | 1 |
| call_6OXUOUIE2rRjEBuks62vnmEP | **cli_review** (depth-2, parent `task2_implementer`) | **all** | **(omitted)** | (omitted) | 183434 | 1 | 1 |

**rep6 (7 spawns)**

| call_id | task_name | fork_turns | model | reasoning_effort | child_bytes | child_skill_reads_strict | child_task_complete |
|---|---|---|---|---|---:|---:|---:|
| call_1jVjhT4uLwybuAw23enbeKcx | task1_implementer | none | gpt-5.6-terra | high | 198012 | 1 | 1 |
| call_3wAnCiP7KG6JkmjvoaS4Sqqc | task1_reviewer | none | gpt-5.6-terra | high | 109663 | 0 | 1 |
| call_oqdTieQ4EdwzHtaHZ5eX1p3r | task2_implementer | none | gpt-5.6-terra | high | 249701 | 2 | 1 |
| call_63GxWgE3UfJ3zwgGDra7odnR | task2_reviewer | none | gpt-5.6-terra | high | 111957 | 1 | 1 |
| call_dQkXFhQg1EvWqn9i0OoMPvNX | task3_implementer | none | gpt-5.6-terra | high | 247351 | 1 | 1 |
| call_wcvRaIWbTFWX2KtdhGcbz3hw | task3_reviewer | none | gpt-5.6-terra | high | 98691 | 0 | 1 |
| call_2zsLVgjPvSrUBRuTWBn2xUIg | final_reviewer | none | gpt-5.6-terra | high | 126714 | 1 | 1 |

**rep7 (9 spawns)**

| call_id | task_name | fork_turns | model | reasoning_effort | child_bytes | child_skill_reads_strict | child_task_complete |
|---|---|---|---|---|---:|---:|---:|
| call_vjjS2zQnhiuVGtSuK1SJAtTP | task1_implementer | none | gpt-5.6-terra | high | 181391 | 1 | 1 |
| call_XGW2WDzTJ9yJnQIUuqXhd0Yt | task1_reviewer | none | gpt-5.6-terra | high | 101299 | 1 | 1 |
| call_GAFO7ofrQMIff9fAYMgiJVXf | task2_implementer | none | gpt-5.6-terra | high | 208751 | 2 | 1 |
| call_g30oyifxVqhsymkMqunLE7JP | task2_reviewer | none | gpt-5.6-terra | high | 100645 | 1 | 1 |
| call_t1dYBzyou16fUVKk5dM8Sg0J | task3_implementer | none | gpt-5.6-terra | high | 154068 | 2 | 1 |
| call_NBHlfkwHNGkO7W0QjXOyxmgW | task3_reviewer | none | gpt-5.6-terra | high | 85798 | 1 | 1 |
| call_ILoiD4Fkjz4OkNrr3Yer4Avp | final_reviewer | none | gpt-5.6-terra | high | 132241 | 1 | 1 |
| call_AyXMhoSIz2pH8sDz0xsrL85J | final_fix_implementer | none | gpt-5.6-terra | high | 189096 | 1 | 2 |
| call_GvusIio6wimvCO5BElk1dEil | final_fix_reviewer | none | gpt-5.6-terra | medium | 91572 | 1 | 1 |

**rep8 (9 spawns)**

| call_id | task_name | fork_turns | model | reasoning_effort | child_bytes | child_skill_reads_strict | child_task_complete |
|---|---|---|---|---|---:|---:|---:|
| call_ULd5JYR8DZQ1JPPO1cn8zjbc | task1_implementer | none | gpt-5.6-terra | high | 193822 | 2 | 1 |
| call_c8sa9pjFtApgBV4IgxIo4AtM | task1_reviewer | none | gpt-5.6-terra | high | 91395 | 1 | 1 |
| call_KaAf31LW1Tr7oYINrLaQLz1p | task2_implementer | none | gpt-5.6-terra | high | 344893 | 4 | 2 |
| call_qkqQW9WVGp0yNcDTXQLOzG6A | task2_reviewer | none | gpt-5.6-terra | high | 101444 | 1 | 1 |
| call_b4ScXJZm6BtDUx0Yixqi6upU | task3_implementer | none | gpt-5.6-terra | high | 149012 | 2 | 1 |
| call_ekcRMdCFXhpVxifWBH5hh594 | task3_reviewer | none | gpt-5.6-terra | high | 99688 | 1 | 1 |
| call_8hKJ1CcxcUyoSVjzMwI8fbzd | final_reviewer | none | gpt-5.6-terra | high | 116762 | 1 | 1 |
| call_K7LiOMJCpWTelrCjnLQR9oxR | final_fix_reviewer | none | gpt-5.6-terra | medium | 87913 | 1 | 1 |
| call_Bo0d18dsnRsFsfGEshUePoLs | **task1_reviewer** (depth-2, parent `task1_implementer`) | none | **(omitted)** | (omitted) | 118266 | 1 | 1 |

**Treatment aggregate (33/33 spawns):** 97.0% isolated (32/33 `"none"`,
1 `"all"`), **93.9% explicit model** (31/33), 6.1% model-omitted (2/33),
100% child-resolved, 100% child `task_complete`.

**Depth-2 spawn finding (both model-omission misses trace here):** every
spawn issued directly by a root controller on either arm (14/14 dev +
31/31 spinout = 45/45) is explicit-model. The only 2 model-omitted
spawns across all 47 are **not root-controller dispatches** — both are
issued by an *implementer child recursively calling `spawn_agent` a
second level down* (`agent_path` in the raw rollout:
`/root/task2_implementer/cli_review` in spinout rep5,
`/root/task1_implementer/task1_reviewer` in spinout rep8), confirmed by
tracing `parent_rollout` back to a non-root file. One of these two
(`cli_review`) is also the *only* `fork_turns:"all"` spawn observed in
either battery — a full-history fork issued by a child, not the root.
Both depth-2 spawns occur only on the treatment (spinout) arm in this
sample; baseline (dev, 2 reps) shows zero depth-2 forking. Sample size
is small (2 events) and task-count-per-rep differs between arms (dev
reps had no fix-round; 2 of 4 spinout reps did), so this is reported as
an observation, not a causal claim about the spinout branch encouraging
more child-initiated recursion — flagged for E6 (which already owns the
fork-isolation axis) rather than adjudicated here.

## Three verdicts (per task instructions)

### (a) Baseline fork_turns confound check: does 100% "none" hold at 0.146?

**Yes, cleanly.** 14/14 baseline spawns at CLI 0.146.0 are
`fork_turns:"none"`, identical to Task 6's 34/34 at CLI 0.144.4. The CLI
version bump registered as a confound in the amendment does **not**
disturb the fork-isolation result — Task 6's baseline finding (SDD
dispatches are isolated, not full-history forks) replicates at the field
CLI version. No regression toward `"all"`/partial on baseline.

### (b) Axis A treatment: % explicit model vs. the 100% success criterion

**Criterion not literally met (93.9% vs. 100%), but the story changed
in a way the literal number doesn't capture.** At 0.144.4 both arms
were 0% explicit model (Task 6); at 0.146.0, treatment is 93.9% (31/33)
and — critically — **baseline is also 100%** (14/14), not 0%. The
CLI-version gate was the actual blocker in Task 6, not a `dev`-vs-spinout
skill-content difference: `dev`'s own
`subagent-driven-development/SKILL.md` (line 177, present before this
campaign, not spinout-specific) already says "Always specify the model
explicitly when dispatching a subagent" — it simply had no parameter to
act on pre-0.145. Once the CLI unlocks `model`/`reasoning_effort` on
`spawn_agent`, both arms' *root controllers* comply at 100% (45/45
combined). Treatment's shortfall from literal 100% is entirely the 2
depth-2 child-initiated spawns documented above, not a root-controller
regression. **Reframed reading: axis A no longer discriminates baseline
from treatment at the field CLI version** — the spinout branch's
specific contribution (its CLI-version-conditional `codex-tools.md`
hint text) is not shown to be doing incremental work beyond what the
CLI unlock + `dev`'s pre-existing generic instruction already achieve.
This is a materially different conclusion than Task 6's "inconclusive
by infrastructure" framing: it's not just unblocked, it's now
non-discriminating between arms at the root-controller level, with a
genuinely new (if small-sample) finding about depth-2 spawns instead.

### (c) Completion parity

**Full parity, both arms, all new reps.** 14/14 dev children and 33/33
spinout children resolved with `task_complete` present (`>=1`; a couple
of spinout rep7/rep8 children show `task_complete: 2`, consistent with a
resumed fix-round child completing twice, still counted as present).
All 6 new reps gauntlet-passed. No completion regression from the CLI
bump or from either arm.

## Budget

$25.01 total this task ($6.64 dev coding + $0.63 dev gauntlet + $16.42
spinout coding + $1.31 spinout gauntlet), against the plan's ≈$32
estimate. E1 running total across all three batteries (Task 6 baseline +
Task 6 axis-A treatment + this re-test): $20.59 + $21.28 + $25.01 =
**$66.88**.

Sub `used_percent` (`rate_limits.primary.used_percent`, last
`token_count` event of the controller rollout):

- Baseline battery: 3.0% (rep5, first) -> 3.0% (rep6, last) — flat.
- Treatment battery: 4.0% (rep5, first) -> 7.0% (rep8, last) — +3.0
  points.

## Deviations from the brief

1. **`score_e1.py`'s output-filename collision overwrote Task 6's
   committed baseline/treatment JSON artifacts** (`out/e1-cx-sdd-small-dev.json`,
   `out/e1-cx-sdd-small-spinout.json`) on first invocation — the script
   derives its output filename from the battery-dir label
   (`cx-sdd-small-dev` / `cx-sdd-small-spinout`), which is identical
   whether scoring rep1-4 or rep5-8/rep5-6, since `REP_START` only
   changes which reps are scored, not the label. Caught immediately via
   `git status`/`git diff --stat` before doing anything else; recovered
   with `git checkout --` on both files (restoring Task 6's original
   34-spawn aggregates unmodified) and re-saved this task's new-reps-only
   output under distinct filenames (`e1-cx-sdd-small-dev-cli0146.json`,
   `e1-cx-sdd-small-spinout-cli0146.json`, `label` field updated to
   match). Verified post-recovery: originals back to 34/34 spawns each,
   new files hold 14/33 spawns respectively. No data was lost, but this
   is a real latent footgun in `score_e1.py` worth fixing (e.g.
   incorporating the rep range into the label) before the next
   REP_START-extended battery — flagged, not fixed here (out of this
   task's scope).
2. Empty stray sibling directory under `results/cx-eff-cx-sdd-small-spinout-rep6/`
   — see "Minor deviation" note above. Not investigated further.
3. Container `down`/`up` was exercised once manually (to verify
   `codex --version` before spending) in addition to the `up`/`down`
   cycles `run-quorum.sh` performs per arm switch — redundant but
   harmless, confirms the same image both ways.

## Report

STATUS: DONE
COMMITS: evals checkout (local, not pushed) `6266ced` — container Codex
CLI bump 0.144.4 -> 0.146.0. autoresearch repo — see task-6b-report.md
for the commit hash of this report + JSON + ledger/log updates.
SUMMARY: Bumped the eval container's pinned Codex CLI to 0.146.0
(newest published exact-version npm release), rebuilt, verified
`codex --version` and per-rep `session_meta.cli_version` both read
0.146.0 across all 6 new reps. Re-ran E1 baseline (dev, 2 reps) and
axis-A treatment (spinout, 4 reps) at the new CLI version, extending
the existing rep1-4 batteries via `REP_START` rather than replacing
them. (a) Baseline fork-hygiene confound check: clean, 14/14
`fork_turns:"none"`, matching Task 6. (b) Axis A: treatment hits 93.9%
explicit model (31/33), up from 0% at 0.144.4 — but baseline also jumps
to 100% (14/14), so axis A no longer discriminates dev from spinout at
the field CLI version; root-caused to a pre-existing `dev`-branch
instruction that was blocked by the same CLI gate, not a spinout-specific
skill difference. The 2 treatment misses are both depth-2
(child-initiated) recursive spawns, not root-controller dispatches — a
new, small-sample finding flagged for E6. (c) Completion parity: 100%
both arms, all reps. Cost $25.01 (within the ~$32 estimate); E1's
running total across all three batteries is $66.88.
CONCERNS: (1) Axis A's headline finding from Task 6 ("spinout branch
fixes model-explicitness") does not survive this re-test in its original
form — the effect looks CLI-version-driven, not branch-driven, since
baseline gets the same benefit. This should be corrected wherever Task
6's finding gets cited downstream (hypothesis log Findings entry
appended below covers this). (2) `score_e1.py`'s label-collision bug
(deviation 1) is a real risk for any future REP_START-extended battery
and should be fixed before it's relied on again — I recovered cleanly
this time but did not fix the script itself (out of scope for this
task). (3) The depth-2 spawn finding (2/47, both model-omitted, one also
the only `fork_turns:"all"` in either battery) is genuinely new and
sample-size-limited (n=2) — worth a dedicated look under E6 rather than
extrapolating from here. (4) I manually brought the container up once
before the batteries to verify the version, which `run-quorum.sh`
redundantly repeats — harmless but means the container was rebuilt from
cold twice in the arm-switch sense; did not affect cost or results.
