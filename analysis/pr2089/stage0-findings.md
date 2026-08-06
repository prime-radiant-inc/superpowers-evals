# Stage 0 — corpus rescore for PR obra/superpowers#2089

Instrument: `src/seats/` + `src/cli/seat-scan.ts`. Raw output `analysis/pr2089/seat-scan.json`
(293 run dirs with per-thread logs — 140 claude, 153 codex — 3501 seats).

PR #2089 adds a paragraph to `skills/subagent-driven-development/task-reviewer-prompt.md`
telling the per-task reviewer to re-read illegible test evidence rather than re-run the suite.
Since the PR is unmerged, every recorded run is a control-condition observation.

## Era gate

The re-run prohibition the PR augments (`Do not re-run the suite to confirm their report.`)
entered on **2026-06-09** (`e08ad066` lineage). The controller-side twin
(`Do not ask a reviewer to re-run tests the implementer already ran`, `SKILL.md`) entered the
same day (`5aea3dca` lineage). Runs before 2026-06-09 predate both and are excluded below.

## Finding 1 — within-run seat comparison (drift-immune), claude, June 2026 cluster

Same runs contribute every seat, so scenario/model/revision differences hit all rows equally.

| role | runs | seats | ≥1 suite run | ≥1 redundant |
|---|---|---|---|---|
| task_reviewer (**treated by #2089**) | 69 | 670 | 322 (48%) | 306 (45%) |
| implementer (expected to run tests) | 70 | 642 | 504 (78%) | 215 (33%) |
| controller | 108 | 162 | 120 (74%) | 109 (67%) |
| final_reviewer (untreated, `requesting-code-review/code-reviewer.md`) | 61 | 62 | 46 (74%) | 41 (66%) |
| fix_reviewer (untreated, `re-review-prompt.md`) | 29 | 60 | 19 (31%) | 18 (30%) |

**The PR is aimed at the right seat.** The final reviewer has the higher per-seat rate (66% vs
45%) but there is only one per run, while a run carries ~10 task reviewers. Of the 365 reviewer
seats with a redundant suite run, **306 (84%) are task reviewers** — the seat #2089 treats.

This retracts an earlier working hypothesis ("the PR treats a 4% seat and leaves a 54% seat
untouched"). That hypothesis came from an untested prototype over a 26-seat subsample.

## Finding 2 — the pathology is ~5x worse on claude than in the lane the PR measured

Post-prohibition, per-task reviewer seats:

| agent | seats | ≥1 suite run | ≥1 full suite | ≥1 redundant |
|---|---|---|---|---|
| claude | 648 | 289 (44%) | 282 | 273 (42%) |
| codex | 231 | 41 (17%) | 22 | 20 (8%) |

The PR's own evidence is Codex-only (GPT-5.6 family). Codex here is 17%/8%, corroborating its
~12% premise. Claude is 44%/42%. If the paragraph works, its value is largest on the agent the
PR never tested.

## Finding 3 — this is NOT a usable control rate for today's `dev`

622 of 648 post-prohibition claude task-reviewer seats are June 2026 runs with **no recorded
`superpowers_rev`** (predating the verdict schema's provenance fields). The only seats at a
known revision are 26 at `c686bb947` (2026-07-23), all on 1–2-task mid-loop fixtures, which
show 1/26 — not comparable to the multi-task fractals/svelte scenarios that dominate June.

Two months of SDD changes between the June cluster and current `dev` are unmeasured. **A control
arm for #2089 requires fresh reps at a pinned `dev` ref.** The corpus is a screen and an
instrument validation, not a control.

## Instrument corrections vs the throwaway prototypes

Prototype regexes matched whole tool payloads, producing large false-positive counts:

- **codex: 4284 flagged → 3320.** 1082 false positives removed (505 `spawn_agent` task prompts
  telling a subagent to run `npm test`, 466 `apply_patch` bodies, 69 `send_input`, 41 exec prose,
  1 `update_plan`), and 118 true positives recovered (`cmd:"git diff --check\nnpm test"` — the
  escaped newline defeated the prototype's boundary class).
- **claude: 2291 → 2200.** 91 false positives removed, 0 true positives lost. Example:
  `git commit -m "$(cat <<'EOF' … npm test passes with 14 tests green. EOF )"`.

## Known limits

1. **`redundant` is an upper bound.** Patch events proxy tree mutation; git checkout/stash/merge
   and `npm install` are invisible. Real corpus case flagged redundant but legitimate:
   `git stash && go test ./internal/cli/... -shuffle=on; git stash pop`.
2. **968 codex seats (28%) carry `agent_path: null`** (CLI 0.134.0 / 0.144.3 recorded only
   `agent_role`) and hold 1872 suite runs. They are `role=other`. Codex reviewer rows above
   therefore describe 62 of 153 codex runs.
3. 187 of 293 runs predate the provenance fields, so `scenario`/`credential`/`superpowers_rev`
   are null; `agent` is still unambiguous from the log dialect.
4. 4 claude labels and 8 codex paths are genuinely ambiguous and route to `other`.
