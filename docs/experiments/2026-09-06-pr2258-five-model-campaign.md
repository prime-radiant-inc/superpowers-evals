# 2026-09-06 PR 2258 five-model base-vs-head campaign

**Status:** PREPARED — not yet registered. Results are appended below once
the campaign seals.
**Kind:** exploratory (descriptive readout per model; no release gate)
**Venue:** quorum appliance, campaign platform, via the installed helper
**Spec:** `docs/superpowers/specs/2026-09-06-pr2258-five-model-campaign-design.md`
**Ledger cap:** $1,500 (Drew, 2026-09-06). Estimate about $720 before
reserves and retries, about $900 with them.

## Question

Does obra/superpowers PR 2258 (head `069edf3f`, "fix: preserve shared intent
through design and planning") improve purpose discovery and stage approval
in brainstorming and writing-plans, without regressing the surrounding
brainstorming, writing-plans, and SDD behaviors, across five models at xhigh
effort?

## Hypotheses

1. Purpose discovery on `brainstorming-todo-purpose-discovery` improves on
   head versus base within each model (the pilot saw 1/4 to 4/4 on Codex
   Astra and Sol with the strict observer scenario).
2. None of the eight guard scenarios regresses on head.
3. `sdd-go-fractals-opus48` pass rate, cost, and duration are unchanged
   within noise; the PR does not touch SDD execution.

## Frozen configuration

| Arm | Agent | Credential | Superpowers | Effort |
| --- | --- | --- | --- | --- |
| `codex_astra_pr2258_base` / `_head` | codex | `openai_responses_6astra` | `fd02874a` / `069edf3f` | xhigh |
| `codex_sol_pr2258_base` / `_head` | codex | `openai_responses_56sol` | same | xhigh |
| `codex_luna_pr2258_base` / `_head` | codex | `openai_responses_56luna` | same | xhigh |
| `claude_opus5_pr2258_base` / `_head` | claude | `opus5_bedrock` | same | xhigh |
| `claude_opus48_pr2258_base` / `_head` | claude | `opus_bedrock` | same | xhigh |

Suite `suites/pr2258_five_model.yaml`: ten scenarios per comparison, n=1
except `brainstorming-todo-purpose-discovery` (n=2) and
`sdd-go-fractals-opus48` (n=3); 130 planned samples; reserve 4; two attempts
per sample; 7800 s per attempt; global cap 6. Grader `sonnet5_bedrock`
(`anthropic.claude-sonnet-5`). Pricing snapshot
`docs/experiments/2026-09-06-pr2258-pricing/current.json`.

`brainstorming-todo-purpose-discovery` is an ORDINARY Gauntlet-graded
scenario measuring purpose elicitation and incorporation. It is a different
measurement from the pilot's strict saved-revision approval chronology and
must not be compared numerically with the pilot's canonical pass rate.

Base `fd02874a` is the PR's actual base and `origin/dev`; `origin/main`
(`b36e0829`, v6.3.0) differs from it only in CODE_OF_CONDUCT.md.

## Effort evidence

Smoke campaign 1 (`d86c1e39-28ef-46eb-9d4d-d247bb863b5e`, suite
`pr2258_effort_smoke`, evals `86d2f594`, gauntlet `588a81e8`, launched
2026-09-07 01:43Z, both attempts passed inside their containers):

- Codex (`codex_luna_pr2258_head`, gpt-5.6-luna, codex-cli 0.146.0): the
  generated `config.toml` opens with root `model_reasoning_effort = "xhigh"`
  and the rollout carries one `"effort":"xhigh"` record. The effective level
  is observed. Subject $0.016, grader $0.125, pricing as of 2026-09-06.
- Claude (`claude_opus48_pr2258_head`, Opus 4.8 via Mantle, Claude Code
  2.1.209): the run-scoped `.claude-env` carries
  `CLAUDE_CODE_EFFORT_LEVEL='xhigh'` and the launcher forwards it (the
  launcher isolation test proves the forwarding). Claude Code 2.1.209 records
  no effort level anywhere in the run home: the session transcript has no
  effort field (2.1.258 does record one on message records), the state file
  has none, and the TUI shows none in the Gauntlet screen captures. The
  Claude arms therefore rest on proven delivery of the documented variable,
  not on an observed level. Subject $0.195, grader $0.154, pricing as of
  2026-09-06.
- Both verdicts stamp `provenance.effort: "xhigh"`; neither role reports
  unpriced models.

## Registration record

- Smoke campaign 1: `d86c1e39-28ef-46eb-9d4d-d247bb863b5e`, input digest
  `f47d3b22…`, 2 cells, 2 slots. Both attempts ran and passed, but the
  campaign recorded both as `no_usable_result`: the attempt publisher
  refused every run directory holding an empty placeholder directory
  (Gauntlet's `screenshots/` and `artifacts/`, git's `refs/tags`,
  `objects/pack`, `objects/info`) as an unlisted artifact, and the
  controller recorded "invalid or missing published evidence". This is a
  platform defect in the strict manifest publisher that landed on
  2026-09-03; no campaign attempt could have published since, which also
  explains the two negative parallel-diagnostic campaigns. Fixed by
  tolerating empty, non-symlinked unlisted directories only
  (`src/campaign/attempt-publish.ts`), with the end-to-end publication test
  now leaving an empty directory so the gap cannot reopen. Smoke 1's two
  runs remain in the campaign's staging as evidence; they were not repaired
  or counted. A second smoke follows on the fixed source.
- Smoke campaign 2: to fill.
- Campaign id, `input_digest`, frozen refs (evals, gauntlet, superpowers per
  arm), cell count (50), planned slots (130): to fill.

## Results

Pending.
