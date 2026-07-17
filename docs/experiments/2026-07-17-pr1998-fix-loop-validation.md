# 2026-07-17 — PR #1998 (SDD fix-loop redesign): independent eval campaign pre-registration

Pre-registration for the independent replicate-and-extend campaign against
obra/superpowers#1998 (`sdd-fix-loop-redesign`), per
`docs/superpowers/specs/2026-07-16-pr1998-eval-campaign-design.md` and
`docs/superpowers/plans/2026-07-17-pr1998-eval-campaign.md`. Ticket:
PRI-2650. This entry is written before any measured run and is filled in as
the campaign proceeds — negative results get equal billing with wins.

## Hypotheses

Copied verbatim from the spec's "Objective and decision rule" section.

Four claims get independently tested:

1. The redesign's breaker/park/BLOCKED behaviors hold (GREEN replication).
2. dev genuinely exhibits the motivating defects, including the coin-flip
   mechanism split at a real n (RED replication).
3. codex handles fix rounds through a sanctioned route — native resume if
   the harness supports it, else the specified (never-yet-run) fallback.
4. Core redesign mechanics nobody has probed — round-4 escalation to a
   more capable model, findings-scoped re-review — actually happen.

## Config

- **DEV_PIN (control):** `fb7b07088ed03da76508b8a70a87bf4f15b2412a` —
  superpowers `dev` tip, resolved via
  `git ls-remote https://github.com/obra/superpowers.git refs/heads/dev` on
  2026-07-17. Same tip the 2026-07-15/16 #1943 panels used (`fb7b07088ed0`
  short) — dev has not moved since.
- **Treatment:** PR #1998 head `1f97eda0fc73faac6cdc870bfeadfdaa3b431a00`
  (`1f97eda`) — confirmed via
  `gh pr view 1998 --repo obra/superpowers --json headRefOid` on 2026-07-17;
  matches the spec's pin exactly. A force-push mid-campaign stops affected
  blocks and re-pins (spec contingency, noted here if it happens).
- **Credentials:** claude → `opus_bedrock` (appliance default; this branch
  carries `max_concurrency: 6`, quota probed 2026-07-16, PRI-2650 — see
  `credentials.yaml`). codex → explicit `--credentials openai_responses`
  (the appliance `codex_sub` default has no auth seeded).
- **Grader:** harness-pinned `claude-sonnet-5` (billed on the shared
  direct-Anthropic key, separate exhaustible budget from the coding-agent
  credentials — top up and re-check between batches per the spec's
  preflight).
- **Appliance:** shared `evals-appliance` (Tailscale). `evals_ref` is
  pinned to evals `main` — unmerged scenario/route-extension work cannot
  produce measured runs until it merges and the box syncs. Preflight
  (doctor/prepare both arms, grader credit check, obol pricing check ≥0.8.0)
  precedes any measured run.

## Pre-registered protocols

Copied verbatim from the spec's "Measurement protocols" section.

- **Block 2 — mechanism classification (pre-registered):** scenario
  verdicts are outcome-gated and do *not* measure mechanism. Every dev-arm
  run of `sdd-fix-loop-resumes-implementer` (n=7) gets a transcript read
  classifying it: {resumed implementer, fresh/dedicated fix dispatch,
  pre-flight defused, other}. Criterion: the coin-flip claim is
  *supported* if ≥2 distinct mechanisms are each observed ≥2× among runs
  that entered a fix cycle; if <4 runs enter a fix cycle, the block is
  reported as underpowered — not adjudicated either way.
- **Blocks 4–6 — resume sweep (pre-registered):** every treatment-arm
  transcript is swept for organic fix cycles; each is classified with the
  block-2 taxonomy. Organic rounds 1–3 resumes are the only obtainable
  live-resume evidence (see observability limit above).
- **Codex capability precheck (before block 3):** establish whether codex
  can send a follow-up message to a live spawned agent (docs + a cheap
  local probe, not an appliance run). Outcome sets block 3's expected
  route; the route actually taken is read from each transcript.
- **Triage-triggered pairing:** blocks 4–6 run controls only on a fail,
  but never as a lone late-window control — a fail triggers a fresh
  *contemporaneous pair* (treatment + control submitted together), which
  is what the nonstationarity doctrine permits.

(The "see observability limit above" cross-reference is to the spec's
"Known observability limit" paragraph, `docs/superpowers/specs/2026-07-16-pr1998-eval-campaign-design.md`:
every seeded-restart fixture kills the live implementer, so rounds 1–3
*live* resume cannot be forced by any seeded scenario — only observed
organically, which is what the sweep above is for.)

## Verdicts

Empty per-block tables, mirroring the spec's Run matrix block names and
planned n per cell. Filled in as runs land; no outcomes pre-filled.

### Block 0 — Scenario audit

No runs (fix-before-run gate: hostile read of the 3 new scenarios' checks/
fixtures for false-pass holes, incl. non-ASCII literal traps, plus closing
the planted-defect false-pass residual).

**Status:**

### Block 1 — Replication core

| Arm | Agent | Scenarios | n each | Verdict |
|---|---|---|---|---|
| Control (dev) | claude | 3 (all) | 3 | |
| Treatment (PR) | claude | 3 (all) | 3 | |
| Control (dev) | codex | 2 (unpinned breakers) | 3 | |
| Treatment (PR) | codex | 2 (unpinned breakers) | 3 | |

Planned: 30 runs (18 claude + 12 codex).

### Block 2 — Coin-flip base rate

| Arm | Agent | Scenario | Additional n | Verdict |
|---|---|---|---|---|
| Control (dev) | claude | sdd-fix-loop-resumes-implementer | 4 (→ n=7 cumulative with block 1) | |

Planned: 4 runs.

### Block 3 — Codex fix-route

Gated on the codex capability precheck (above).

| Arm | Agent | n | Verdict |
|---|---|---|---|
| Treatment (PR) | codex | 3 | |
| Control (dev) | codex | 2 | |

Planned: 5 runs.

### Block 4 — Regression (author's 4)

Author's 4 regression scenarios (per
`docs/experiments/2026-07-sdd-fix-loop-redesign.md`):
sdd-quality-reviewer-catches-planted-defect, sdd-rejects-extra-features,
sdd-escalates-broken-plan, sdd-spec-constraint-preserved.

| Arm | Agent | Scenarios | n | Verdict |
|---|---|---|---|---|
| Treatment (PR) | claude | 4 scenarios | 1 each, except planted-defect n=3 | |
| Treatment (PR) | codex | 4 scenarios | 1 each | |
| (gated) contemporaneous paired re-run on any fail | both arms | — | n=2 | |

Planned: 10 runs (+4 gated).

### Block 5 — Interaction

| Arm | Agent | Scenario | n | Verdict |
|---|---|---|---|---|
| Both | both | #1943 pair (sdd-same-plan-resume, sdd-stale-foreign-workspace) | 1 each (8 cells: 2 scenarios × 2 arms × 2 agents) | |
| Both | claude | sdd-spec-context-consumed (known noisy) | 3 each (6 cells) | |
| Both | codex | user-pref-sdd-no-strategy-prompt | 1 each (2 cells) | |
| Treatment (PR) | claude | mid-conversation-skill-invocation | 1 | |

Planned: 17 runs (8+6+2+1). Differential read per cell against the paired
dev arm, with priors from the #1943 validation (stale-foreign on dev:
claude ✗ / codex ✓ — so a codex ✗ on the PR arm is a candidate regression,
not expected noise).

### Block 6 — End-to-end

| Arm | Agent | Scenario | n | Verdict |
|---|---|---|---|---|
| Treatment (PR) | claude | sdd-go-fractals-opus48 | 1 | |
| Treatment (PR) | codex | sdd-go-fractals-gpt55 | 1 | |
| (gated) contemporaneous paired re-run on any fail | both arms | — | n=2 | |

Planned: 2 runs (+2 gated). Post-run process-tree check for the
vite-orphan wedge (even though fractals is the chosen fixture).

### Block 7 — New hostile probes

Dev lacks these rules entirely — the control arm is the RED half of each
probe's before/after claim, so it gets real n (raised 1→2 per the
2026-07-17 execution amendment).

| Arm | Agent | Probe | n | Verdict |
|---|---|---|---|---|
| Treatment (PR) | claude | (a) round-4 escalation integrity | 2 | |
| Control (dev) | claude | (a) round-4 escalation integrity | 2 | |
| Treatment (PR) | claude | (b) scoped re-review discipline | 2 | |
| Control (dev) | claude | (b) scoped re-review discipline | 2 | |
| Treatment (PR) | claude | (c) final-review single-fix-wave | 2 | |
| Control (dev) | claude | (c) final-review single-fix-wave | 2 | |

Planned: 12 runs.

## Negative results

None yet — no measured runs have started. Recorded here at equal billing
with positive findings as the campaign proceeds, per the project's
experiment-log convention.

## Deviations

- **2026-07-17 — log filename dated a day after the spec.** The spec
  (`docs/superpowers/specs/2026-07-16-pr1998-eval-campaign-design.md`) is
  dated 2026-07-16; this log is created 2026-07-17 — the campaign started a
  day after spec sign-off. No content deviation, just a date-label offset.

## Economics

Spec estimate (Run matrix "Totals"): ≈80 measured runs + ≤8 triage-gated
contingency ≈ $270–390. Actuals recorded here per batch as the campaign
runs (obol-priced coding-agent cost + gauntlet grader spend, tracked
separately per the preflight's grader-budget note — grader bills the
shared direct-Anthropic key, a distinct exhaustible budget from the
`opus_bedrock`/`openai_responses` coding-agent credentials).
