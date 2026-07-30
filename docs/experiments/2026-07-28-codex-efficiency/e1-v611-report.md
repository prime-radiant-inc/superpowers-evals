# E1-v611: fresh-session pathology reproduction against superpowers v6.1.1 (Amendment 2)

Pre-registration: `logs/2026-07-28-codex-efficiency.md`, "E1-v611
PRE-REGISTRATION" (2026-07-29). Registered two branches — pathology
reproduces at `v6.1.1` (skill-version-dependent, fixed by `v6.2.0`) vs.
clean like `dev`/`spinout` at CLI 0.146 (strengthens the long-history
theory) — with a stated bet on the clean branch, grounded in a direct diff
of the dispatch-governing files between `/tmp/sp-arm-v611` (tag `v6.1.1`,
commit `d884ae0`) and `/tmp/sp-arm-dev`.

**Headline: Branch 2 (clean) confirmed.** 22/22 root-controller spawns
across all 3 reps are isolated (`fork_turns:"none"`) and explicit-model —
matching `dev-cli0146`'s 14/14 and `spinout-cli0146`'s 31/31
root-controller rate exactly. The one non-clean spawn (23rd, 4.3% of the
raw total) is a depth-2, child-initiated spawn — the same shape already
seen twice on `spinout-cli0146`, now reproduced independently a third time
on a different skill version. No new root-level pattern; the bet lands.

## Rig

Ran from **lane B** (`/Users/jesse/git/superpowers/evals-lane-b`, a second
independent `scripts/evals-container` checkout/container brought up
alongside lane A's in-flight E2 scoring container — see the implementation
commit for lane-isolation verification):

```
EVALS_ROOT=/Users/jesse/git/superpowers/evals-lane-b JOBS=2 \
  bash campaigns/codex-efficiency/run-quorum.sh v611 cx-sdd-small 3
```

`run-quorum.sh` gained `EVALS_ROOT`/`JOBS`/`v611`-arm support for this
task. `JOBS=2` batched the 3 reps as (rep1, rep2) concurrently, then rep3 —
confirmed from the run log (`rep1`/`rep2` both announced before either
finished) and from wall-clock: rep1/rep2 both started ~18:51, rep3 started
~19:13 (after rep1/rep2's ~19-22 min runs completed). **No sequential
fallback was needed** — JOBS=2 worked cleanly, 3/3 reps gauntlet-passed.

Codex CLI confirmed `0.146.0` on all 3 reps (`session_meta.cli_version`,
read directly off each root rollout) — same image as the `dev-cli0146`/
`spinout-cli0146` comparison arms, isolating skill version as the only
variable relative to those two.

## Battery run inventory

| Rep | Run dir (leaf) | Gauntlet | Spawns | Coding cost | Gauntlet cost | Total |
|---|---|---|---:|---:|---:|---:|
| 1 | `cx-eff-cx-sdd-small-v611-rep1/...-7a5d` | pass | 7 | $3.30 | $0.28 | $3.58 |
| 2 | `cx-eff-cx-sdd-small-v611-rep2/...-4ff0` | pass | 9 | $4.60 | $0.30 | $4.90 |
| 3 | `cx-eff-cx-sdd-small-v611-rep3/...-2d73` | pass | 7 | $3.34 | $0.35 | $3.69 |
| **Total** | | 3/3 pass | **23** | **$11.24** | **$0.93** | **$12.17** |

**Minor deviation, noted not chased (same known artifact as Task 6b's
retest):** `results/cx-eff-cx-sdd-small-v611-rep2/` contains a second,
empty sibling directory
(`cx-eff-cx-sdd-small-codex-codex_sub-linux-20260729T185106Z-4ff0/`, no
`verdict.json`, no session logs, two empty subdirectories under
`coding-agent-workdir/.worktrees/strutils-implementation/.superpowers/sdd/`)
alongside the real scored run dir
(`cx-sdd-small-codex-codex_sub-linux-20260729T185106Z-4ff0/`, same
timestamp+hash suffix). quorum's own run log only ever reports the latter
as the run-dir; the empty sibling contributes no cost and is not scored or
committed.

## Spawn-tuple tables (23 spawns, all inspected)

`child_first_instruction_line` omitted below (structurally always `None` —
same reason as every prior E1 report; full tuples in the JSON artifact).

**rep1 (7 spawns, all root-controller)**

| call_id | task_name | fork_turns | model | reasoning_effort | child_bytes | child_skill_reads_strict | child_task_complete |
|---|---|---|---|---|---:|---:|---:|
| call_7mgDt6ZAbvVOXTV76fAevvUD | task1_implementer | none | gpt-5.6-terra | medium | 180085 | 2 | 1 |
| call_d9nvxSd273LSXEQpqEmQF5B8 | task1_reviewer | none | gpt-5.6-terra | high | 94458 | 1 | 1 |
| call_OpvZRHP8Po7U5bFtNlnI2uRO | task2_implementer | none | gpt-5.6-terra | medium | 210296 | 1 | 1 |
| call_R6C6mNcVwEVr8lsoKCC6jc5a | task2_reviewer | none | gpt-5.6-terra | high | 114819 | 1 | 1 |
| call_NYMdqu9Dce6xbzmTezMgwCZu | task3_implementer | none | gpt-5.6-terra | medium | 182184 | 2 | 2 |
| call_yMf9aAC4D5YxgM8bsn8rnBjr | task3_reviewer | none | gpt-5.6-terra | high | 145296 | 1 | 2 |
| call_ptvYtfb0KrOHfrWJLFqxx8Rg | final_reviewer | none | gpt-5.6-sol | xhigh | 144229 | 2 | 1 |

Aggregate: 7/7 isolated, 7/7 explicit model, 0 depth-2 spawns.

**rep2 (9 spawns, 8 root-controller + 1 depth-2)**

| call_id | task_name | fork_turns | model | reasoning_effort | child_bytes | child_skill_reads_strict | child_task_complete |
|---|---|---|---|---|---:|---:|---:|
| call_X8507pCdvxlaYbovBcZmljDj | task1_implementer | none | gpt-5.6-terra | medium | 213450 | 3 | 1 |
| call_W4GFHvtFKt9FiO1BlasJPUgd | task1_reviewer | none | gpt-5.6-terra | medium | 95289 | 1 | 1 |
| call_IFOzd6HB5Lqj7DuhcKCAScHt | task2_implementer | none | gpt-5.6-terra | medium | 213624 | 1 | 1 |
| call_Cso5j9EQITF63kLAzS1TxE2U | task2_reviewer | none | gpt-5.6-terra | medium | 105160 | 1 | 1 |
| call_Ildme1DQGmYQnHA2w9pOMtn9 | task3_implementer | none | gpt-5.6-terra | medium | 184987 | 2 | 1 |
| call_59Mo6pTwujxA4ZbqOSgR0JDW | task3_reviewer | none | gpt-5.6-terra | medium | 93586 | 1 | 1 |
| call_oZTopU9foXLDBA10txkKnZSu | final_reviewer | none | gpt-5.6-sol | high | 144345 | 1 | 2 |
| call_6pccA8mnLtRPuDRcEv0iWcaA | final_fixer | none | gpt-5.6-terra | medium | 176962 | 2 | 1 |
| call_3oLmZx1mlIVMGX0dYQg0PW7N | **cli_reviewer** (depth-2, parent `task2_implementer`) | **all** | **(omitted)** | (omitted) | 204844 | 1 | 1 |

Aggregate: 8/9 isolated (88.9%), 8/9 explicit model (88.9%). The one miss
on both axes is the same spawn — `cli_reviewer`, issued by
`task2_implementer` (confirmed via `parent_rollout` matching
`task2_implementer`'s own `child_rollout` exactly), not by root. **This is
the identical shape (task-name `cli_review`/`cli_reviewer`, issued by a
`task2_implementer`, `fork_turns:"all"`, model omitted) already observed
twice on `spinout-cli0146`** (Task 6b's re-test, rep5 `cli_review` and
rep8 `task1_reviewer`, both depth-2/model-omitted, one also `fork_turns:
"all"`) — now a third independent occurrence, on a different skill
version.

**rep3 (7 spawns, all root-controller)**

| call_id | task_name | fork_turns | model | reasoning_effort | child_bytes | child_skill_reads_strict | child_task_complete |
|---|---|---|---|---|---:|---:|---:|
| call_0QPSykPllbvTHLOe3gk0SB2y | task1_implementer | none | gpt-5.6-terra | medium | 162283 | 3 | 1 |
| call_32cs8odUN9q0TsszEeJD4B68 | task1_reviewer | none | gpt-5.6-terra | medium | 89515 | 1 | 1 |
| call_yjIz8LjEsz53n4FCJbK3vmU8 | task2_implementer | none | gpt-5.6-terra | medium | 174467 | 4 | 1 |
| call_IpKFagu2Na9TG7OPC3wutjzU | task2_reviewer | none | gpt-5.6-terra | medium | 104176 | 1 | 1 |
| call_9aMC7ojWOHMXPzbwHDwG3zfN | task3_implementer | none | gpt-5.6-terra | medium | 164312 | 1 | 1 |
| call_bgoG3icXG9WdWxWoSTH9Om4F | task3_reviewer | none | gpt-5.6-terra | medium | 96243 | 1 | 1 |
| call_WaXs3lZh2cHOIzW3kGu6bO1c | final_reviewer | none | gpt-5.6-sol | xhigh | 139483 | 2 | 1 |

Aggregate: 7/7 isolated, 7/7 explicit model, 0 depth-2 spawns.

**Battery aggregate (23/23 spawns, raw):** 95.7% isolated (22/23), 95.7%
explicit model (22/23), 4.3% `fork_turns:"all"` (1/23), 100%
child-resolved, 100% child `task_complete` present.

**Root-controller-only aggregate (22/22 spawns, excluding the one depth-2
spawn):** 100% isolated, 100% explicit model — the number that's
comparable to `dev-cli0146` and `spinout-cli0146`'s own root-controller
rates below.

## Three-arm comparison (all at Codex CLI 0.146.0)

Comparison arms are the **CLI-0.146-matched** `dev`/`spinout` aggregates
(`out/e1-cx-sdd-small-dev-cli0146.json`,
`out/e1-cx-sdd-small-spinout-cli0146.json` — Task 6b's re-test), not the
original Task 6 batteries (CLI 0.144.4, established as a load-bearing
confound: baseline explicit-model jumped 0%→100% purely from the CLI
bump). Comparing `v611` against version-matched arms isolates skill
version as the only difference.

| Arm | Skill version | Reps | Raw spawns | Isolated | Explicit model | `fork_turns:"all"` | Root-controller isolated | Root-controller explicit model | Depth-2 spawns |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|
| `dev-cli0146` | `dev` (post-v6.2.0) | 2 | 14 | 100.0% (14/14) | 100.0% (14/14) | 0.0% (0/14) | 100.0% (14/14) | 100.0% (14/14) | 0 |
| `spinout-cli0146` | `codex-spinout-fixes` @ `bd68a94` | 4 | 33 | 97.0% (32/33) | 93.9% (31/33) | 3.0% (1/33) | 100.0% (31/31) | 100.0% (31/31) | 2 |
| `v611` (this battery) | `v6.1.1` (tag, pre-`dev`) | 3 | 23 | 95.7% (22/23) | 95.7% (22/23) | 4.3% (1/23) | 100.0% (22/22) | 100.0% (22/22) | 1 |

**Root-controller rate is 100%/100% on every one of the three skill
versions** (67/67 combined root-controller spawns, isolated and
explicit-model, zero exceptions). The only spawns anywhere across all 9
reps / 70 total spawns that are non-isolated or model-omitted are 3
depth-2, child-initiated spawns (0 on `dev`, 2 on `spinout`, 1 on `v611`)
— every one of them issued by an implementer or reviewer child recursively
calling `spawn_agent`, never by the root controller. `v611`'s depth-2 rate
(1/23 raw, 4.3%) sits inside the same small-sample range as `spinout`'s
(2/33, 6.1%); `dev`'s 2-rep sample shows none, consistent with its smaller
n rather than a real zero.

## Verdict

**Branch 2 (clean, like `dev`/`spinout`) — confirmed, as bet.** The
pre-registration's two branches were not symmetric hedges: the ground
check (fork_turns text absent from all three skill versions'
dispatch-governing files; the "always specify model explicitly"
instruction and the `model: [MODEL — REQUIRED...]` dispatch-template
placeholder present byte-identical in both `v6.1.1` and `dev`) predicted
no skill-text lever existed for `v6.1.1` to behave differently, and the
data landed exactly there: **100% root-controller isolation and
explicit-model on all three tested skill versions, at the field CLI
version.** The "clean" fresh-session result is not `v6.2.0`-dependent —
it already held at `v6.1.1`, the oldest version tested.

**This strengthens the long-history theory, not weakens it.** Three
independent skill versions spanning the one release with the most
plausible candidate fix (`v6.2.0`) all produce identical root-controller
fork-hygiene behavior on the same short, fresh `cx-sdd-small` scenario.
The audit's original full-history-fork / model-omission narrative remains
unreproduced on this scenario shape at *any* skill version — consistent
with E1 axis B's and E2-FULL's own terminal framing that the pathology is
a property of long-running, heavily-loaded controller sessions
(compaction, deep accumulated context), which E6 is built to elicit, not
a property this short-scenario/skill-version design space can surface.

**The depth-2 finding is now a 3-occurrence pattern, not a 1-battery
anomaly, and is independent of skill version.** `v6.1.1`'s single depth-2
spawn (`cli_reviewer`, issued by `task2_implementer`, `fork_turns:"all"`,
model omitted) reproduces the *exact* task-name/parent/fork/model shape
already seen twice on `spinout-cli0146` (`cli_review` from
`task2_implementer` in one rep, `task1_reviewer` from `task1_implementer`
in another). Sample size is still small (n=3 across 9 reps, 2 different
skill versions, 0 occurrences on `dev`'s 2-rep sample) — not a claim that
any specific skill version causes more child-initiated recursion, but a
strengthened signal that whatever governs depth-2 dispatch behavior
(implementer/reviewer children calling `spawn_agent` themselves) is
**not** skill-content-driven either, same conclusion as the root-controller
finding. Flagged for E6 (which already owns the fork-isolation axis),
not adjudicated here.

## Budget

$12.17 total ($11.24 coding + $0.93 gauntlet), 3 reps. Sub `used_percent`
(`rate_limits.primary.used_percent`, root rollouts' `token_count` events):
**17.0%** (rep1/rep2's first event, both started ~simultaneously under
JOBS=2) → **19.0%** (rep3's last event) — +2.0 points across the battery.

## Report

STATUS: DONE
COMMITS: see the implementation commit for this task (run-quorum.sh
EVALS_ROOT/JOBS/v611 support + this report + JSON + ledger/log updates);
pre-registration committed separately beforehand.
SUMMARY: Stood up a second, independent evals-container lane (lane B,
`/Users/jesse/git/superpowers/evals-lane-b`) running concurrently with
lane A's in-flight E2 container, and extended `run-quorum.sh` with
`EVALS_ROOT`/`JOBS`/a `v611` arm mapping. Ran 3 reps of `cx-sdd-small`
against superpowers `v6.1.1` (tag, pre-`v6.2.0`) at Codex CLI 0.146.0,
JOBS=2 (no sequential fallback needed). Result: 22/22 root-controller
spawns isolated + explicit-model (100%/100%), matching `dev-cli0146`
(14/14) and `spinout-cli0146` (31/31) exactly — confirms the
pre-registered bet (Branch 2, clean) and closes the one live alternative
to the long-history theory (that the clean fresh-session result was
skill-version-dependent). The one non-clean spawn is a depth-2,
child-initiated spawn reproducing the exact shape already seen twice on
`spinout` — now a 3-occurrence, cross-skill-version pattern flagged for
E6. Cost $12.17 (3 reps); sub used_percent 17.0%→19.0%.
CONCERNS: (1) `v611`'s 3-rep sample is smaller than `dev-cli0146`'s 2-rep/
`spinout-cli0146`'s 4-rep comparison arms combined coverage is still small
(9 reps, 70 spawns total across all three arms) — the depth-2 pattern is
suggestive, not statistically established. (2) The stray empty sibling
directory under `cx-eff-cx-sdd-small-v611-rep2/` (documented above) is the
same unfixed `run-quorum.sh` staging artifact flagged in Task 6b's retest
report — still not investigated. (3) Lane B required copying
`node_modules` from lane A (not just the `.env`/`.env.container` files
anticipated by the task) because a fresh `bun install` run inside the
container against a bind-mounted, freshly-cloned checkout failed with
`bun is unable to write files to tempdir: AccessDenied` — consistent with
a cross-filesystem (Docker Desktop bind-mount vs. overlay2) hardlink
limitation in Bun's package store, not a lane-B-specific misconfiguration;
worked around by `rsync`-ing lane A's already-installed `node_modules`
(same `bun.lock`, byte-identical `package.json`) rather than reinstalling.
Flagged as a real gap in the lane-B setup instructions, not fixed at the
tooling level.
