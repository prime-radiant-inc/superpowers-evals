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

## Effort evidence (to fill from the smoke and the first pair)

- Claude: count of `"effort":"xhigh"` on session-log message records in the
  smoke attempt and the first campaign attempt.
- Codex: the `turn_context` effort value in the smoke attempt and the first
  campaign attempt.

## Registration record (to fill)

- Smoke campaign id, verdicts, costs, effort evidence.
- Campaign id, `input_digest`, frozen refs (evals, gauntlet, superpowers per
  arm), cell count (50), planned slots (130).

## Results

Pending.
