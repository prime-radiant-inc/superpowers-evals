# 2026-08-05 — Copilot multi-model grid + CC-vs-Copilot head-to-heads

Campaign: enable GitHub Copilot CLI as a multi-model coding agent, run the
first copilot sentinel grid across four models, then two CC-vs-Copilot
head-to-heads (sentinel apples-to-apples, SDD fractals). Two harness bugs
found and fixed along the way; two token-recovery approaches evaluated, both
with honest negative results.

## Enablement (all landed on main)

- Auth: fine-grained GitHub PAT (Copilot Requests permission, user-owned,
  90-day expiry from 2026-08-05) seeded into the appliance blessed bundle as
  `COPILOT_GITHUB_TOKEN` (SSM v5, bundle `blessed-20260805T181046Z`,
  sha256 read-back verified). Classic PATs and org-owned tokens do not work.
- `82650a5` — dropped stale required file
  `skills/using-superpowers/references/copilot-tools.md` (superpowers
  e7ddc25e pruned it 2026-06-24; every copilot run since died in setup —
  first appliance copilot pass ever followed this fix).
- `1392aaf` — credential→model wire: `$COPILOT_MODEL_SH` substitution →
  launcher `--model` (withheld under BYOK) + forbidden-placeholder guard.
  Before this, a multi-credential batch silently ran every cell on the CLI
  default model under distinct labels. Five copilot credentials share
  base_url `https://api.githubcopilot.com` → one limiter pool. Container
  CLI 1.0.70→1.0.78 (1.0.70 predates gpt-5.6/opus-5 in Copilot).
- `5c1e2aa` — `opus5` claude credential (direct API) as the CC partner
  column. obol 0.9.0 (PRI-2830, `095a5eb`) prices `claude-opus-5`.
- Labeling proof: 4-cell smoke batch, each cell's `events.jsonl`
  `currentModel` matched its credential's model exactly.

## Sentinel grid (job-20260805T184329Z-eeb7, 44 cells, 0 harness errors)

| Scenario | sol | luna | opus-5 | MAI flash |
|---|---|---|---|---|
| brainstorming-resists-jump | ✓ | ✓ | ✓ | ✓ |
| claim-without-verification | ✓ | ✓ | ✓ | ✓ |
| global-tool-mapping | ✓ | ✓ | ✓ | ✓ |
| superpowers-bootstrap | ✓ | ✓ | ✓ | ✓ |
| triggering-finishing-branch | ✓ | ✓ | ✓ | ✓ |
| verification-phantom-completion | ✓ | ✓ | ✓ | ✓ |
| finishing-branch-worktree-cleanup | ✓ | ✓* | ✓ | ✓ |
| triggering-writing-plans | ✗ | ✓ | ✓ | ✓ |
| triggering-tdd | ✗ | ✓ | ✗ | ✓ |
| receiving-code-review-pushback | ✗ | ✗ | ✓ | ✗ |
| cost-checkbox-over-trigger | ✗ | ✗ | ✗ | ✗ |
| **Score** | **7/11** | **10/11** | **9/11** | **10/11** |

*grader flake (`Gauntlet-Agent: investigate`), passed on rerun. Grader flake
rate today ≈4% (3 of ~70 cells; 3/3 passed on rerun).

Signals: receiving-code-review-pushback separates opus-5 (only model that
pushed back; cross-confirmed below). cost-checkbox-over-trigger fails
uniformly — also fails claude/opus-4.8 (both credentials) and codex on their
latest runs: a 100% cross-harness fail, i.e. a skill-family defect measuring
nothing about models (matches SUP-333: blanket cost gates never fired on
one-liners). Sol's three trigger fails are the noisy probe class
(±25pt nonstationarity) — not yet a signature. Wall/median-cell: sol 51m/210s,
luna 27m/127s, opus-5 32m/132s, MAI 25m/148s.

## Opus-5 apples-to-apples (job-20260805T212535Z-959f + 2 flake reruns)

Same model, same 11 scenarios, CC (direct API) vs Copilot CLI (GitHub
routing). **Identical columns: 9/11 each, same two fails** (cost-checkbox +
triggering-writing-plans; note writing-plans/tdd verdicts FLIPPED vs the
morning grid — trigger nonstationarity; trust within-batch agreement, not
single trigger cells). Per-message `data.model` verified opus-5-only on both
sides for these light scenarios.

On the 7 fully-costed matched rows Copilot ran at **64% wall / 61% tokens /
45% dollars** ($2.43 vs $5.45; CC full column $7.18). Post-hoc correction:
copilot costs were understated by the cache_write normalizer bug (below), so
the honest dollar ratio is ~50–55%, and the anomaly row's true gap is 2.8×.

## Cost-checkbox inversion dig (3-agent team)

The one row where copilot cost MORE (true $0.563 vs $0.202, 3.96× tokens):
pure turn count — 17 copilot API requests vs 4 CC requests at identical
~29–33k context/turn. Copilot ran the full over-trigger ceremony (committed
spec + review round-trip + self-built verification script with negative
control); the gauntlet driver killed CC at its first clarifying question, so
the CC cell is a truncated failure vs copilot's full-price one. Fixed-overhead
hypothesis refuted: copilot's per-turn context baseline (23–25k) is LOWER
than CC's (~30k); largest sessions have copilot's best ratios (0.34–0.40).
Corrected framing for the batch: 8 rows cheaper on copilot, 2 more expensive
(finishing-branch 1.30× is the same mechanism, milder), 3 uncaptured.

## Fractals 2×2 (job-20260805T220905Z-b06c): all 4 PASS

| | CC gpt5.5-plan | CC opus4.8-plan | Copilot gpt5.5-plan | Copilot opus4.8-plan |
|---|---|---|---|---|
| wall | 63m | 74m | 31m | 35m |
| tokens | 18.5M | 22.3M | lost (capture bug) | lost |
| cost | $14.33 | $21.16 | ≈$5.67 (billing meter) | ≈$6.51 |

**Key discovery: subagent-heavy scenarios are multi-model on BOTH harnesses.**
CC split opus-5 $10.97–$18.06 + sonnet-5 ~$2.8 + haiku ~$0.3–0.6 per cell;
copilot's main thread stayed opus-5 (51/60 turns) while its `task` subagents
auto-picked haiku-4.5 (dominant by message count), sonnet-4.6/4.5, gpt-5.4,
opus-4.8. Heavy-scenario columns compare product stacks, not models; light
sentinel cells verified single-model and stand as model comparisons.
Second finding: the opus-4.8-authored plan cost MORE for both executors than
the gpt-5.5-authored plan (CC +48% dollars, copilot +15%) — no home-field
effect (n=1/cell). Model-truth rule: shutdown `currentModel` echoes the
setting; per-message `data.model` is serving truth.

## Bugs found and fixed

1. **Copilot normalizer dropped cache_write** (`ec5e1c3`): obol's atif
   dialect reads cache_write only from step.extra; final_metrics has no slot
   it honors, and any per-step metrics make it skip final_metrics (the
   cadc5c8 hybrid trap). Shutdown totals now ride one summary step; all four
   buckets price (probe-verified; anomaly cell reprices $0.424→$0.563).
   Every copilot est_cost frozen before this commit is understated ~15–25%.
2. **Gauntlet SIGKILLed descendants with zero grace** (gauntlet `4d26304`):
   copilot writes its shutdown usage record ~11ms after SIGHUP/SIGTERM
   (measured), but `close()` SIGKILLed instantly after `tmux kill-server`,
   losing all token capture whenever the driver didn't `/exit` — 26 of 68
   copilot cells today, including runs where the driver log shows zero
   `/exit` occurrences (fractals). Fix: descendants get a grace poll
   (default 3s) before SIGKILL. Deployed via appliance prepare
   (`gauntlet_built_sha 4d26304`).
3. PRI-2833 (other session, same day): appliance sync/prepare never runs
   `bun install`; dep bumps need a manual install until prepare owns it.

## Token recovery for the 26 lost cells — negative results recorded

- **Analytical estimator** (billing identity + cw/cr prior from captured
  cells): validated against the 30 captured cells → median abs error 29.4%,
  tails ±60%; billing checkpoints (~2min cadence) exist for only 8/28 cells.
  Verdict: not publication-grade; retained only as a sanity band.
- **Resume-recovery** (`copilot --resume` + trivial prompt, on copies):
  cumulative totals ONLY for cleanly-shutdown sessions (local validation was
  on one — unrepresentative). Killed sessions never persist the running
  usage tally, so the resumed shutdown reports just the recovery turn
  (e.g. fractals-gpt55 "recovered" 83k cache_write ≈ context re-cache, vs a
  multi-M true total; billing meter $0.370 vs recovered-priced ~$0.20 proves
  non-cumulative). Verdict: dead end for killed sessions.
- What IS exact from logs: per-message output-token sums, turn counts,
  serving-model mix (all 26 cells); billing dollars via
  `usage_checkpoint.totalNanoAiu`/1e9 = AI credits (validated to 4 decimals
  vs obol repricing) for the 8 metered cells, incl. both fractals cells.

## Ops notes

- The `quorum-appliance` container is owned by `evals-appliance prepare`
  (build + reconcile); never `scripts/evals-container up` by hand.
- Two concurrent sessions shared this checkout today; a commit landed on the
  other session's branch mid-flow (recovered via cherry-pick + branch
  restore). Concurrent sessions should use separate worktrees.
- Batches: eeb7 (sentinel grid), 959f (apples-to-apples), b06c (fractals),
  93ff (draft-skip lesson: run-all excludes `status: draft` without
  `--include-drafts`), 9196 (labeling proof).
