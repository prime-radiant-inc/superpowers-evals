# codex: gpt-5.6-sol vs gpt-5.5 comparison grid (first 5.6 batch)

- **Date:** 2026-07-14 (overnight)
- **Ticket:** PRI-2583
- **Batch:** `batch-20260714T065645Z-a6a4` — 142 cells (71 scenarios × codex × {`openai_responses` gpt-5.5, `openai_responses_56sol` gpt-5.6-sol}), 134 runnable, `--jobs 5`
- **Surface:** local evals container (Linux, codex 0.144.3), superpowers `d884ae04`, evals `0dbff04`
- **Hypothesis:** gpt-5.6-sol is a drop-in for the codex column; OpenAI claims ~54% coding token efficiency at identical per-MTok rates ($5/$0.50/$30).

## Raw matrix topline (MISLEADING — read the artifact section)

| column | pass | fail | indet |
|---|---|---|---|
| gpt-5.5 | 44 | 12 | 11 |
| gpt-5.6-sol | 21 | 37 | 9 |

## Artifact 1: `skill-called` is blind on 5.6 rollouts (grading, not behavior)

**27 of the 37 5.6 fails have `gauntlet.status: pass`** (vs exactly 1 such cell on 5.5),
and all 27 failed the `skill-called` transcript verb (22 alone, 5 in combination).
Mechanism, confirmed on `triggering-test-driven-development`: the 5.5 run's
`trajectory.json` carries canonical tool names (`Bash` ×32, `Edit` ×6,
`update_plan` ×8); the 5.6 run of the same scenario normalizes **every** call to a
raw `exec` (×24). Codex emits a different rollout shape when driving the 5.6
family, `src/normalize/codex.ts` doesn't map it, and the skill-invocation
detector doesn't recognize `exec` — so every skill read is invisible.

Corollary: `not skill-called` checks pass **vacuously** on 5.6, so the
user-pref-* slice of the 5.6 pass column is soft until the normalizer is fixed.
The 5.6 deterministic layer is unreliable in BOTH directions; only the
Gauntlet-Agent lens is trustworthy for this batch.

## Artifact 2: OpenAI quota exhaustion killed the tail

15 cells (7× 5.5, 8× 5.6) went indeterminate with codex returning
"Quota exceeded. Check your plan and billing details." from ~09:20Z — both
columns share one `OPENAI_API_KEY`. Alphabetical-tail scenarios
(`worktree-*`, `writing-*`, `verification-*`) are the casualties. Re-run after
billing top-up.

## Surviving behavioral signal (Gauntlet-Agent lens, non-quota cells)

| column | gauntlet pass | gauntlet fail | investigate (non-quota) |
|---|---|---|---|
| gpt-5.5 | 45 | 11 | 4 |
| gpt-5.6-sol | 48 | 10 | 1 |

**Verdict-level equivalence, slightly favorable to 5.6.** No evidence of a
behavioral regression; the raw matrix delta is grading artifact.

## Token economics (quota-dead runs excluded)

| | gpt-5.5 (60 runs) | gpt-5.6-sol (59 runs) |
|---|---|---|
| fresh input | 11.2M | 4.4M (−61%) |
| output | 0.9M | 0.6M (−33%) |
| cache reads | 67.1M | 57.2M (−15%) |
| coding walltime | 4.0h | 5.0h (+25%) |

At identical rates this is roughly **40% cheaper per equivalent workload**,
consistent with OpenAI's efficiency claim, traded for ~25% more wall-clock.
Column scenario mixes differ slightly (which runs died of quota), so treat
percentages as first-read approximations. 5.6 cells report `est_cost_usd:
null`/`partial` — obol 0.7.0 (as_of 2026-07-09) has no `gpt-5.6-*` keys.

## Offline re-grade with the fixed normalizer (2026-07-14, PRI-2584 @ `8527d9c`)

The normalizer fix (unpack the unified `exec` JS into canonical calls) landed
the same day. Re-normalizing the batch's stored 5.6 rollouts and re-executing
the exact transcript checks that decided each cell (offline analysis — stored
verdicts NOT rewritten):

- **26 of the 27 artifact-fails flip to pass.** The 27th
  (`sdd-quality-reviewer-catches-planted-defect`) has its `skill-called` cured
  too; its remaining fail is a `command-succeeds` FS check that needs a live
  re-run to settle.
- **1 vacuous pass flips to fail:** `subagent-dispatch-no-overtrigger` —
  codex-5.6 really did over-trigger brainstorming; the blind detector had
  passed it via `not skill-called`.

**Corrected 5.6 column (projection): 46 ✓ · 11–12 ✗ · 9 ⊘** vs gpt-5.5's
44 ✓ · 12 ✗ · 11 ⊘ — deterministic layer now agrees with the Gauntlet lens:
parity, slightly favorable to Sol.

## Follow-ups

1. ~~Fix `src/normalize/codex.ts`~~ — done (PRI-2584, `8527d9c`, offline
   re-grade above). Stored verdicts in `results/` still carry the artifact
   fails; either re-run the 28 affected 5.6 cells for clean stored verdicts or
   build a regrade command (open decision).
2. ~~Top up OpenAI billing~~ — done; re-run of the 15 quota-dead cells started
   2026-07-14 (standalone runs, not part of the original batch dir).
3. obol: add `gpt-5.6-sol` ($5/$0.50/$30) so the column prices.
4. Do NOT log a "5.6 regresses skill compliance" finding anywhere — the raw
   matrix says that and the raw matrix is wrong.
