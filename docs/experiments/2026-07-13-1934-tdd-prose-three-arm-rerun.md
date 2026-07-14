# #1934 TDD-prose three-arm re-run (pre-registered)

**Date:** 2026-07-13 · **Status:** RUNNING · **Author:** Drew (+ harness)

## Why

The 07-08 campaign concluded the TDD "Why Order Matters" removal degrades
test-first behavior under "tests after" pressure (claude 8/10→5/10 @ n=10,
codex corroboration) and #1934 was updated upstream on that basis (rebuttals
folded into the rationalization table, commit `1529f369`). Two challenges to
the original finding have since surfaced and are unresolved:

1. **Mechanism**: every observed failure is `skill-called=F` (the TDD skill
   never invoked at all), yet #1934 changes only skill *bodies* — zero
   frontmatter/description changes across all 12 skills, `using-superpowers`
   untouched. Bodies enter context only after invocation, so the arms should
   be context-identical at the decision point. (Evidence gap: the deep grep
   of an agent home for deleted-body text was run on only ONE run, arm
   unconfirmed — circular if it was a treatment run.)
2. **Statistics**: 8/10 vs 5/10 is Fisher p≈0.35; n=10/arm has ~13% power
   for a real 0.8→0.5 drop. The pre-registered "≥2-failure gap" rule was met
   but is weak evidence at this n.
3. **Campaign confound**: control was v6.1.0 (`f268f7c`) but every PR branch
   sits on v6.1.1 (`c809093a`), so treatment arms silently carried the whole
   v6.1.1 release. For claude the delta is codex-packaging-only (skills/
   byte-identical); for codex it deletes `hooks/session-start-codex` — a
   plausible alternative mechanism for the codex "corroboration".

## Design

Probe: `tdd-holds-under-tests-later-pressure` (scenario rev `f5f1f01`,
byte-identical to the campaign runs). Coding agent: **claude** on
`opus_bedrock` (current default). Grader: claude-sonnet-5 (harness-pinned).
Container CLIs unchanged (claude 2.1.202). Appliance harness: main @
`251ce17`. All arms run fresh — no reuse of campaign runs (their control
ref, credential, and grader differ).

| Arm | Meaning | superpowers ref |
|---|---|---|
| A (control) | v6.1.1 = #1934's true base; Why-Order-Matters prose present | `c809093a2a449e1772e8c87f41ceb6d5e7135464` |
| B (old head) | section deleted (the arm the campaign measured) | `91eba77cf1590926ec9ba9ab3543223fc5a72928` |
| C (new head) | rebuttals folded into rationalization table | `1529f369116bc4df2d9a56a29a02a7b74245e6bc` |

n=20 valid verdicts per arm, submissions interleaved A,B,C per cycle so any
time-varying Bedrock capacity window hits arms symmetrically. Indeterminates
excluded and topped up (max 25 submissions/arm). Single-job appliance lock →
strictly sequential, ~3h, ~$35 total.

## Pre-registered decision rules

1. **Replication (B vs A), primary.** Fisher exact two-sided. p<0.05 →
   original effect is real; the prose is load-bearing. p≥0.05 AND gap ≤2
   failures → the campaign's #1934 TDD verdict is not supported at 2× its
   original n; treat the 07-08 finding as noise.
2. **Fix validation (C vs A).** Same test. C within noise of A → new head
   is behavior-neutral on this probe → merge-safe on this evidence.
3. **Extension rule.** If B-vs-A lands in 0.05≤p<0.20 with a gap ≥3
   failures, extend A and B to n=40 before concluding (power at n=20 for a
   real 0.8→0.5 is only ~39%; don't let an underpowered miss masquerade as
   a disproof).
4. **Mechanism audit (regardless of outcome).** For every failing run in
   every arm, record whether the transcript shows the TDD skill in context
   (invocation or SKILL.md read) before the failure. Theory-N predicts ~0.
5. Indeterminates excluded from all counts (infra, not behavior); >5 in one
   arm → flag the arm as infrastructure-compromised, do not conclude.

## Predictions (locked)

- Theory F (campaign finding real): B ≈ 3-failure drop vs A; C recovers.
- Theory N (noise): A ≈ B ≈ C, all within Fisher noise; failures remain
  100% skill-not-invoked.

## Results

(pending)
