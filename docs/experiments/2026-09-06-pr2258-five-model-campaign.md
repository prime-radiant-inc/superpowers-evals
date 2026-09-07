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
- Smoke campaign 2: `f10bb086-aaae-466b-af7f-e13a7ee4de71`, input digest
  `f13bb330…`, evals `555bbcb5` (the publication fix), gauntlet `588a81e8`,
  launched 2026-09-07 02:32Z, completed 02:36Z. Both arms pass 1/1 with
  `publication_valid: true`; the published runs are
  `00-quorum-smoke-hello-world-claude-opus_bedrock-linux-20260907T023300Z-cdeb`
  (Opus 4.8: subject $0.193, grader $0.169, wall 105 s) and
  `00-quorum-smoke-hello-world-codex-openai_responses_56luna-linux-20260907T023301Z-0c98`
  (Luna: subject $0.008, grader $0.117, wall 108 s); combined $0.487 with
  complete cost coverage. Both verdicts stamp `provenance.effort: "xhigh"`
  and price against the 2026-09-06 snapshot with no unpriced models. Codex:
  root `model_reasoning_effort = "xhigh"` in the generated config and one
  `"effort":"xhigh"` rollout record. Claude: `CLAUDE_CODE_EFFORT_LEVEL` in
  the run env file; no in-log observation is possible on 2.1.209 (see Effort
  evidence). Each published run carries the five empty placeholder
  directories the publisher now tolerates.
- Campaign: `e7cc05be-894b-44c2-abed-b3cb285cad82`, input digest
  `57216be7cc7e7bf4fa791c23e5b10223b3fa928f580968d961d45d43a82d2110`,
  registered 2026-09-07 about 02:39Z with `--global-cap 6`. Frozen refs:
  evals `7bfa7f56`, gauntlet `588a81e8`, superpowers `fd02874a` on every
  `_base` arm and `069edf3f` on every `_head` arm. 50 cells, 130 planned
  slots, 200 reserve slots (the suite's `reserve: 4` per cell; replacement
  capacity, not planned spend), no excluded cells. All ten execution-surface
  arms carry `effort: xhigh` with the expected models (gpt-6-astra,
  gpt-5.6-sol, gpt-5.6-luna, anthropic.claude-opus-5,
  anthropic.claude-opus-4-8). Pricing snapshot digest `6423a36b…`; attempt
  bound 7800 s. Pools: the three Codex credentials on one 15-slot Responses
  pool each, `opus5_bedrock` 4, `opus_bedrock` 6, grader `sonnet5_bedrock` 6.

## Campaign 1: cancelled after a second publication defect

Campaign `e7cc05be-894b-44c2-abed-b3cb285cad82` launched 2026-09-07 02:40Z
and was cancelled at 03:27Z (cancellation verified 03:29Z) after $26.91 of
known spend (22 attempts prepared, 14 observed). It is recorded here as
negative instrument evidence, not as results.

What published: fourteen Codex Astra verdicts across seven scenarios, all
`pass` on both base and head, all priced against the 2026-09-06 snapshot,
all with `provenance.effort: "xhigh"` and the xhigh level observed in every
Codex rollout (`brainstorming-companion-just-in-time`,
`brainstorming-resists-jump-to-implementation`,
`cost-spec-plan-duplication`, `user-pref-corp-no-brainstorm-met`,
`user-pref-corp-no-brainstorm-unmet`, `user-pref-sdd-no-strategy-prompt`,
plus the two smoke-verified scenarios). Nothing else reached a verdict
before cancellation; the Astra fractals and writing-plans attempts in flight
were terminated.

What failed: every `brainstorming-todo-purpose-discovery` attempt (four,
including the block's replacement) and the first `user-pref-no-brainstorm`
attempt ended "invalid or missing authenticated verdict" although the runs
completed (the head purpose-discovery run had passed all five post-checks).
Cause, from the attempt stderr: the runner's attempt-manifest writer
(`src/runner/manifest.ts`) refuses any symlink under the run directory, and
the agent's Vite scaffold leaves `node_modules/.bin/*` symlinks, so the
manifest was never written and the run could not publish. Any campaign run
that installs npm dependencies or creates a Python venv fails the same way.
This is the second publication defect found by this campaign (the first,
empty placeholder directories, was fixed before launch) and is likewise a
pre-existing platform issue, not an effect of the arm-level effort work.

Why cancel rather than continue: the controller replaces an invalidated
block up to four times, so the fifteen React-scenario blocks would have
burned roughly 120 further attempts without producing the headline
measurement, and a second campaign for those scenarios would still have been
needed. Cancelling and re-running everything on the fixed source is cheaper
and yields one coherent campaign. The fix (record symlinks verbatim in the
manifest as inventory; the publisher accepts only listed, unaltered
symlinks; nothing follows a link) is documented in the ledger and lands as a
separate commit before campaign 2.

## Smoke campaign 3 (on the symlink fix)

`b7bf9dd2-72a3-45bb-9686-fe300e3fae38`, evals `ecf99a43`, launched 2026-09-07
03:55Z, completed 04:04Z, $1.12 with complete coverage. The Codex cell ran
`brainstorming-todo-purpose-discovery` itself on Luna: pass, all five
post-checks, published with 93 artifacts, `provenance.effort: "xhigh"`,
subject $0.10, grader $0.67, 523 s. The Claude hello-world cell passed and
published (72 artifacts, $0.19 + $0.15). Caveat: this Luna run reached its
first product-work action without an npm install, so its run directory held
no symlinks; the symlink path itself is proven by the unit tests and the
end-to-end publication test that now leaves a real symlink, not by this
smoke.

Before campaign 2 the suite's `reserve` was reduced from 4 to 1 per cell
(50 replacement slots instead of 200) to bound replacement spend.

## Campaign 2

`0934ad16-4dc6-4822-ba4a-222e0635e7d1`, input digest
`8615ebc5d29757644fe242204e625047daf4f0b71341c825d8d079f53cb7628d`,
registered 2026-09-07 about 04:08Z with `--global-cap 6` and launched
immediately after. Frozen refs: evals `4f81a83a` (both publication fixes and
the reserve change), gauntlet `588a81e8`, superpowers `fd02874a` on every
`_base` arm and `069edf3f` on every `_head` arm. 50 cells, 130 planned
slots, 50 reserve slots (one per cell), no excluded cells; all ten arms at
`effort: xhigh`; pricing snapshot digest `6423a36b…`; attempt bound 7800 s.

## Results

Pending campaign 2.
