# Dev-tip TDD-pressure regression screen (pre-registered)

**Date:** 2026-07-14 · **Status:** RUNNING · **Author:** Drew (+ harness)

## Why

Across the two 1934 batches, the pooled pass rate on
`tdd-holds-under-tests-later-pressure` dropped from 68% (41/60, 07-13, all
arms on v6.1.x-era content) to 45% (18/40, 07-14, both arms on dev-tip-era
content) — Fisher p=0.024. Two candidate explanations the data cannot
separate: (a) superpowers content between v6.1.1 and dev tip (notably the
`writing-good-tests` ground-up rewrite at the then-dev-HEAD) lowered the
behavior, or (b) day-to-day environment/model drift. This screen separates
them with a same-day interleaved pair.

## Pre-verified surface facts

Between the two arms: identical 14-skill set; all skill descriptions
byte-identical except `finishing-a-development-branch` (#1933, unrelated
to a TDD-pressure prompt); `using-superpowers`, hooks/, and every
`.  *-plugin` manifest byte-identical; TDD skill description identical.
The invocation surface is the same, so the mechanistic prior is FLAT; a
real gap would implicate post-load content (or an undocumented surface).

## Design

| Arm | Content | superpowers ref |
|---|---|---|
| F | v6.1.1 (campaign-era baseline) | `c809093a2a449e1772e8c87f41ceb6d5e7135464` |
| G | dev tip (includes merged #1934) | `4562d18dcfc1ff7c65ec9aae5848539532724a1d` |

Same-day, interleaved F,G; n=20 valid/arm; claude on `opus_bedrock` at
claude-code **2.1.209** (agent-CLI refresh, PR #31 — both arms on the new
CLI, so this screen is internally valid but its absolute rates are NOT
comparable to the 07-13/07-14 batches at 2.1.202); grader claude-sonnet-5;
indeterminates excluded + topped up, max 25 submissions/arm.

## Pre-registered decision rules

1. Fisher two-sided F vs G. **p<0.05 with G<F** → content-linked
   regression confirmed; localize before any fix: mechanism audit splits
   fails into invocation-miss vs loaded-then-failed; loaded-dominant →
   suspect the writing-good-tests rewrite body; invocation-dominant →
   audit injected context per run before touching content.
2. **p≥0.05** → the 07-13→07-14 drop is attributed to day/environment
   drift; record that absolute rates on this probe are not longitudinally
   comparable and close.
3. Indeterminates >5 in one arm → flag infra-compromised, do not conclude.
4. Mechanism audit on all failing runs regardless of outcome.

## Prediction (locked)

Uncertain by design. The surface-identity facts argue FLAT; the p=0.024
cross-day observation is the reason to check anyway.

## Results

(pending)
