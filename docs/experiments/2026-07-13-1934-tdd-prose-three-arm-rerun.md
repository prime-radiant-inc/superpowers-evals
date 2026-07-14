# #1934 TDD-prose three-arm re-run (pre-registered)

**Date:** 2026-07-13 · **Status:** COMPLETE 2026-07-14 · **Author:** Drew (+ harness)

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

Completed 2026-07-14T04:01Z. 71 submissions → 60 valid verdicts (n=20/arm),
7 transient indeterminates (A:3, B:3, C:1 — all under the rule-5 flag
threshold), plus 4 pre-fix `image_build_failed` submissions before PR #29's
Python pin reached the appliance (excluded; see TSV). Runs interleaved
A,B,C throughout; one ~5-minute Bedrock capacity window at ~01:47Z produced
3 consecutive indeterminates, absorbed by top-up.

| Arm | Pass rate | vs A (Fisher two-sided) |
|---|---|---|
| A — control (prose present) | **14/20 (70%)** | — |
| B — old head (section deleted) | **17/20 (85%)** | p = 0.451 |
| C — new head (table fold) | **10/20 (50%)** | p = 0.333 |

**Rule 1 (replication, primary): the campaign's #1934 TDD finding does not
replicate.** At 2× the original n against the corrected control, the
deleted-prose arm B is numerically ABOVE control (85% vs 70%) — the opposite
direction from the campaign's 8/10→5/10. The 07-08 finding is noise admitted
by an underpowered decision rule (its own Fisher was p=0.35 at n=10).

**Rule 2 (fix validation): C is within noise of A** (p=0.33) → the new head
is merge-safe on this evidence. C's numeric trail is addressed by rule 4:

**Rule 4 (mechanism audit) — decisive.** Of the 19 failing runs across all
arms, **18 never had the TDD skill in context at all**: `skill-called=false`,
zero `test-driven-development` references in the trajectory, zero skill-body
text anywhere in the agent home. In those 18 runs the bytes that differ
between arms were provably never read — no version of the prose could have
caused those failures. The 19th (control arm, prose present) DID load the
skill and still failed on ordering (wrote code first). The probe measures
the skill-invocation coin flip, which body-only edits cannot move.

**Post-hoc note (not a decision test): B vs C is p=0.041.** Nominally
significant — and mechanically impossible to attribute to content, since B
and C differ only in table-row prose that was never in context in any of
their 13 combined failures. With 3 comparisons, one p≈0.04 is expected-ish
by chance. This is a live demonstration of how the original false positive
happened: this probe hands out "significant-looking" gaps between arms whose
differences the agent never saw.

**Rule 3 (extension): not triggered** — B-vs-A shows no deficit to extend.

## Conclusions

1. The campaign's actionable recommendation ("KEEP the TDD Why-Order-Matters
   content — it is load-bearing under pressure") is **withdrawn**. The
   #1934 skill-body edits are behavior-neutral on this probe, in any
   variant: delete, fold, or keep.
2. Jesse's table-fold (`1529f369`) is harmless — arguably better prose —
   but it was not evidence-required. #1934 is merge-safe as-is (it still
   needs a rebase: 3-file conflict with current dev).
3. **Probe lesson**: `tdd-holds-under-tests-later-pressure` measures whether
   the skill gets INVOKED under pressure (a name+description+system-prompt
   phenomenon), not what the body says. Body-content differentials need
   probes that condition on the skill being loaded and measure downstream
   compliance. The campaign's other per-skill "prose bet" verdicts that
   relied on this probe class deserve the same skepticism.
4. **Process lesson**: the campaign's rule ("≥2-failure gap at n=5/n=10")
   has false-positive rates far above intuition for ~70-80% base rates.
   Future differentials: pre-register Fisher at n≥20 minimum, and always
   run the mechanism audit before acting on a positive.

Raw records: driver TSV + per-run job IDs in the session scratchpad
(`1934-rerun.tsv`, `audit-full.txt`); run artifacts on the appliance under
`results/tdd-holds-under-tests-later-pressure-claude-opus_bedrock-linux-202607*`.
