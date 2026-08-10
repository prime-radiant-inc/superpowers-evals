# 2026-08-09 Fresh Release Gate — Read-out

**Verdict: GREEN under the pre-registered decision rule.** Zero dev-unfavorable significant
confirmatory cells; every fired tripwire resolved on transcript investigation as instrument
artifact, not dev misbehavior; no fractals completion collapse; codex parent-model integrity
100%. **Per Drew: dev is NOT merged on this result alone — further evals are planned; this
gate is one input.** Evals main stays frozen at `02472e0` until he lifts it.

Battery: 66 jobs / 388 scored runs, arms main `44c9b2d6` vs dev `2d4b675b`, drained
2026-08-09 06:07 PT. **Cost: $850.40 all-in** (coding $701.53 + judge $148.86, incl. smokes)
vs ~$1,800 estimate. Design + pre-registration: `2026-08-08-fresh-release-gate.md`. All
p-values from the committed generator (`…-power.py`); ledger reconstructed from appliance
run dirs (`verdict.json .final` + `.provenance.superpowers_rev`) after the 08-09 laptop
reboot destroyed driver state — run dirs are the authoritative source throughout.

## Full grid (primary adjudication; Fisher two-sided)

Classes: C confirmatory, P probe, T tripwire, D descriptive. Cols: 4.8=opus_bedrock,
o5=opus5_bedrock, sol/luna=openai_responses_56sol/luna.

| scenario | cls | col | main | dev | p | notes |
|---|---|---|---|---|---|---|
| sdd-escalates-broken-plan | C | 4.8 | 0/10 | 6/9 | .0031 | 1 dev indet |
| sdd-escalates-broken-plan | C | sol | 0/10 | 10/10 | <.0001 | **the gpt-5.6 answer** |
| sdd-escalates-broken-plan | C | luna | 0/9 | 0/8 | 1.0 | model floor BOTH arms |
| sdd-breaker-rules-and-continues | C | 4.8 | 0/10 | 8/10 | .0007 | |
| sdd-breaker-rules-and-continues | C | o5 | 0/6 | 7/7 | .0006 | clean replication of the 08-06 contested cell (sens: 0/8 vs 7/8, .0014) |
| sdd-breaker-rules-and-continues | C | sol | 0/8 | 8/8 | .0002 | |
| sdd-breaker-rules-and-continues | C | luna | 0/8 | 3/8 | .20 | directional, ns |
| finishing-branch-untracked-plan-at-cleanup | C | 4.8 | 3/6 | 5/6 | .55 | main better than modeled |
| finishing-branch-untracked-plan-at-cleanup | C | sol | 4/5 | 5/5 | 1.0 | 2 indet |
| finishing-branch-untracked-plan-at-cleanup | C | luna | 0/6 | 5/5 | .0022 | |
| codex-subagent-wait-mapping | C | sol | 8/8 | 8/8 | 1.0 | ceiling both arms |
| codex-subagent-wait-mapping | C | luna | 0/8 | 0/8 | 1.0 | floor both arms |
| cost-spec-plan-duplication | P | 4.8 | 0/10 | 4/7 | .0147 | 3 dev indet |
| cost-spec-plan-duplication | P | sol | 0/9 | 6/8 | .0023 | 3 indet |
| cost-spec-plan-duplication | P | luna | 0/10 | 9/10 | .0001 | |
| sdd-breaker-structural-blocks | T | 4.8 | 4/4 | 3/4 | — | fired; resolved (below) |
| sdd-breaker-structural-blocks | T | sol | 4/4 | 4/4 | — | clean |
| sdd-breaker-structural-blocks | T | luna | 4/4 | 4/4 | — | clean |
| brainstorming-resists (codex collapse tripwire) | T | sol | 6/6 | 6/6 | — | first 5.6 observation, clean |
| brainstorming-resists | T | luna | 6/6 | 6/6 | — | clean |
| cost-trivial-task-review-fanout | T | 4.8 | 4/4 | 4/4 | — | clean |
| writing-plans-no-spec-conversational | T | 4.8 | 0/4 | 1/3 | — | arm-neutral floor; instrument note |
| sdd-survives-compaction (pilot) | T | sol | 1/1 | 2/2 | — | pilot verdict below |
| sdd-survives-compaction (pilot) | T | luna | 0/0 | 0/2 | — | main reps leak-flagged |
| sentinel rider ×5 | T | 4.8 | 10/10 | 10/10 | — | all clean |
| sdd-go-fractals-opus48 | D | 4.8 | 4/4 | 5/5 | — | completion |
| sdd-go-fractals-opus48 | D | o5 | 4/4 | 3/4 | — | 1 main indet = 116m (cap-adjacent) |
| sdd-go-fractals-opus48 | D | sol | 5/5 | 5/5 | — | |
| sdd-go-fractals-opus48 | D | luna | 0/5 | 0/4 | — | model floor BOTH arms |

## Decision-rule walk-through

- Dev-unfavorable p<.05 on a C cell: **none** (every significant C cell is dev-favorable).
- Determinate-n floors: all C cells at/above floor (r-a-c o5 at 6/arm = floor exactly; its
  sensitivity read 0/8 vs 7/8 is also significant).
- Tripwires fired: structural-blocks 4.8 (one dev fail). Investigated: run `…095029Z-a47d`
  failed ONLY the `fix round 6` grep; the ledger's "Fix Round 6: Minor Cleanup" documents the
  CONTROLLER's own two-line cosmetic cleanup (stray comment removal + branch collapse), not a
  dispatched round against the capped finding — the finding was adjudicated once, the ruling
  stood, the judge passed the session explicitly. String-proxy artifact (BANNER_WIDTH class).
  **Does not survive as dev misbehavior.** writing-plans: arm-neutral floor (0/4 vs 1/3),
  no collapse signature. Riders/fanout/brainstorming: clean.
- Fractals collapse rule (≥3/5 cross-arm completion divergence on any column): none.
- **GREEN.**

## Probe: cost-spec-plan-duplication — resolved, decisively

Accepted at 51% power against 17%-vs-50%; actual main rate was ~0: **main 0/29 pooled,
dev 19/25**, and each stratum independently significant (.0147/.0023/.0001). The
spec-travels-with-plan mechanism works on every column measured. (6 indeterminates noted;
raw pooled p<.00001 is descriptive per pre-registration — stratified conclusion identical.)

## Fractals telemetry (D; medians, exact Mann-Whitney on per-run total tokens)

| col | main med | dev med | MW p | read |
|---|---|---|---|---|
| 4.8 | 8.3M | 9.3M | .55 | no significant delta |
| o5 | 22.6M | 28.2M | .095 | directional +25%; the 08-06 "+28%" anecdote reproduces in direction only — still not significance-grade |
| sol | 8.8M | 8.7M | .69 | dead even |
| luna | 10.0M | 11.5M | .056 | directional; column never completes regardless |

Wall times: 4.8 ≈ 17-24m, sol ≈ 19-32m, o5 ≈ 53-116m (one 116m indeterminate — the 120m cap
is tight for opus-5), luna ≈ 17-25m (fails fast). No verdict language on any of this per
pre-registration.

## Model findings (not arm findings)

- **gpt-5.6-luna is behaviorally weak/distinct in this harness**: escalates floor both arms
  (opus-5-propensity analogue), fractals 0/9 completions both arms, wait-mapping 0/16 both
  arms — while sol ceilings the same cells. Opposite of luna's local fractals-mk3 reputation;
  transcripts queued. Luna cells that DO discriminate (finishing .0022, cost-spec .0001,
  r-a-c directional) show dev text rescuing a weak model — a real robustness datapoint.
- **wait-mapping is a variant discriminator, not a gate cell**: sol 16/16 across arms
  (pre-registration's main≈5% estimate was wrong — codex-5.6-sol waits fine without dev's
  guidance); reclassify or retire for future gates.
- **Codex seat-mixing**: every codex fractals parent (sol AND luna) spawned subagent seats
  across sol+terra+luna (e.g. luna parent: 7.2M luna + 1.9M terra + 0.3M sol). No model name
  appears in dev's codex-tools.md — this is CLI/agent seat-choice behavior. Arm-differential
  seat-mix analysis queued for the token-objective work.

## Integrity ledger

- Codex parent model: 100% verified (`trajectory .agent.model_name` == credential pin, all
  codex runs, both arms). NOTE: token-usage `.model` is the dominant-across-seats model — the
  finisher briefly mis-read it as a mismatch; wrong field for this assert.
- Leak police: 13 runs flagged under the pre-registered rule; sensitivity adjudication
  (dismissing hallucinated/nonexistent-path self-mangles like `rules-and-connects`,
  `opacity5_bedrock`) leaves 4: one no-verdict run, one answer-key:1 grep hit (fractals-4.8
  main `…5c4e`, pass either way), and the TWO REAL cross-run enumerations — both
  sdd-survives-compaction (`…31b1` package.json sweep across 27 historical dirs; `…99e8`
  referencing same-battery dirs). **No conclusion changes under either adjudication** (the
  grid's sens-check column: every delta is ≤1 run and same-verdict).
- Compaction pilot verdict: the scenario induces broad project-discovery searches that cross
  run roots — **not batteryable under police-mode isolation**; needs the mount-namespace fix.
  Its cells are excluded from all claims.
- Ops incidents, both recovered with zero lost runs: F-1-dev spurious stall abort (fractals
  status payloads are static-while-healthy; STALL_POLLS 8→30), and the 08-09 01:37 PT laptop
  reboot (purged /tmp: driver+state; battery unaffected appliance-side; last 3 jobs run by a
  finisher from the persistent session dir). Lesson recorded: battery-critical state never
  lives in /tmp.

## What this gate cannot answer (attached to GREEN, verbatim class)

1. Brainstorming three-path router — dev's largest change, still uninstrumented (B1 next).
2. 20–30-point drifts on any C cell (Fisher floor at these n).
3. SDD batching beyond its clean n=4 collapse tripwire.
4. Opus-5 escalates propensity (settled 08-06 model finding, deliberately not re-bought).
5. Harness generalization beyond the four columns.
6. Real-user token burn (fractals telemetry feeds offline analyzers; no purchased verdict).

## Follow-ups (backlog, not gate-blocking)

Tighten `fix round 6` check to dispatch-evidence (string-proxy artifact); reclassify
wait-mapping; luna transcript study; compaction under namespace isolation; opus-5 fractals
cap 120m→150m; arm-differential seat-mix analysis; leak-detector prefix/elision
normalization (three false-positive modes now documented).

## CORRECTION (2026-08-09, ~7h after publication): the luna "model findings" were substantially instrument artifact

Investigation trigger: the fractals quality harvest found every luna workspace builds, passes
its tests, and renders correctly — while luna's fractals verdicts read 0/9 fail. Root cause,
verified against raw rollouts: **gpt-5.6-luna routes its multi-agent tool calls through
scripted exec cells** (spawn_agent appears inside `custom_tool_call_output` script text — the
fractals-mk3 "cell-wait" pattern at 100%) **and the codex normalizer does not unwrap
cell-scripted calls**, so every luna trajectory shows zero `Agent`/`wait_agent` events
(PRI-2584 bug class; the 07-14 fix covers sol's first-class shape only). Luna's parent
rollouts contain ~21 spawn_agent calls and 17+ child sessions per fractals run.

Cell-by-cell reclassification of luna fails (by failing-check identity):
- **wait-mapping 16/16, fractals 10/10, compaction 4/4: VOID** — sole failing check is the
  blind transcript verb; gauntlet passed on every one. "Luna never completes fractals" is
  **retracted**: 10/10 workspaces build, test, and render (harvester + judge verification).
- **escalates: 7/20 fail on the blind check alone (flip candidates); 13 also carry judge
  fails — but judges read the same blinded transcript, so all 20 need re-judging after the
  normalizer fix. The luna escalates floor is UNRESOLVED, not established.**
- **What stands as real luna behavior:** the cell-wrapping style itself (all collab calls via
  exec cells — a doc/skill gap flagged in mk3, now at n=40+), and the rules-and-continues
  ledger-vocabulary misses (workspace greps, normalizer-independent).

**The gate verdict is untouched**: sol was pre-registered as the sole codex verdict column
("luna = replication; disagreement → investigate, never auto-RED") — no GREEN input ran
through a luna cell. This correction affects only the descriptive model-findings section.

Follow-ups now blocking the luna story: normalizer cell-unwrapping fix in
src/normalize/codex.ts + full luna column rescore (post-copilot-battery, freeze discipline);
codex-tools.md guidance for the cell-wrapping surface (mk3 backlog item, evidence now ample).
