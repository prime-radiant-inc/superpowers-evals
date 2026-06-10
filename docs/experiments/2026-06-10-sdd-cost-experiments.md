# 2026-06-10: SDD cost/run-time experiment campaign

One entry per hypothesis, **negative results get equal billing** — the point
of this log is that nobody re-purchases a $50 disproof. Run artifacts:
`evals/results/sdd-go-fractals-claude-20260610T*` (and svelte/planted-defect
same date). Configs: scratch clones under `/tmp/sdd-exp/<variant>` (branch
`sdd-review-dispatch`); the surviving changes land on that branch. Method
docs: `../superpowers/skills/profiling-run-economics.md`; doctrine and
follow-ups: plugin repo spec
`docs/superpowers/specs/2026-06-10-positive-instruction-redesign-design.md`.

Baseline context: previous day's final config measured 44.4 min / 13.4M /
$11.67 on go-fractals (single run). A same-config re-run measured 57.1 min /
20.0M / $14.63. **Treat single-run deltas under ~20% as noise**; reviewer
escape-hatch appetite alone swung reviewer tool calls 1.0 → 6.3 avg between
identical configs.

## Confirmed wins

| Hypothesis | Result | Evidence |
|---|---|---|
| Handing the FINAL whole-branch reviewer a review-package file cuts its work like it did for task reviewers | **WIN** — 33 turns/23 tools → 6 turns/3 tools, at controller-model (opus) prices; opus bill −19% | E1 run 163928Z-9a73 vs 104434Z-a8d1 |
| `model:` as a REQUIRED template line stops dispatch-model decay | **WIN** — 26/26 dispatches explicit (combo) vs decay to `(default)`→opus from Task 3 onward when guidance-only (E2, +$5) | combo 174422Z-98b7 vs E2 163930Z-a65c |
| Positive composition recipe beats prohibition for dispatch construction | **WIN** — recipe 3.0 transcribed values, zero variance; prohibition 4.4 (worse than no guidance, 3.6) | micro-test `/tmp/sdd-exp/micro`, 5 reps/variant, opus |
| Progress ledger (`.git/sdd/progress.md`) is adoptable and free | **WIN** — controller maintained it unprompted-ly well (commit ranges, Minor-findings roll-up, final verdict); run cost in-band | E4 165219Z-b260; motivation: real sessions re-dispatched whole task sequences post-compaction (269 dispatches for ~22 tasks) |
| Unique SHA-range collateral names under `<git-dir>/sdd/` | **WIN** — used by default, worktree/submodule-safe, re-reviews inherently fresh-named | E4 run workdir; smoke tests |

## Negative results (tested, declined — do not re-propose without new evidence)

### Controller turn batching via guidance — DEAD
Hypothesis: telling the controller to combine bookkeeping tool calls into
the dispatch message cuts its ~150-turn floor.
Result: **zero multi-tool assistant messages in every measured run, with and
without the guidance** (E1: 0 of 159 turns; prev-best: 0 of 152). The
controller (opus, extended thinking) emits exactly one tool call per
message. 46% of controller turns contain no tool call at all
(thinking/narration) — matches real-session mining (17-26% thinking-alone +
15-25% narration-only). The turn floor is model behavior, prompt-immune.
Implication: controller cost yields only to structural changes (fewer
dispatches, smaller resident context), not turn discipline.

### Pipelined reviews via parallel tool calls — DEAD
Same root cause: the dispatch-reviewer-and-next-implementer-in-one-message
instruction produced **0 paired dispatches in 29** (E3 171746Z-9d88).

### Pipelined reviews via `run_in_background` — WORKS MECHANICALLY, BENEFIT BELOW NOISE
E3b (180941Z-310e): controller adopted background dispatch for 7 of 28
dispatches, run passed — but 53.6 min / 17.8M / $14.84, band top. Reviews on
these scenarios are only ~30-60s each (~5 min total hideable), swamped by
±6 min run variance, and dual result-stream handling added tokens. Revisit
only for plans whose individual reviews are long.

### "Do not restate the brief" prohibition — BACKFIRED
4.4 spec values re-typed per dispatch vs 3.6 with no guidance at all. The
controller relabeled task details "binding global constraints" to route
around it — rationalization-relocation at composition time. Replaced by the
positive recipe (3.0, zero variance). Nuance: much of the "restating" was
genuinely valuable curation (ambiguity resolution, task-boundary lines);
the recipe permits that and pins exact values to the brief.

### Recipe + nuance clause — REGRESSED THE RECIPE
Appending "name values by reference, quote only the fragment your point
needs" to the winning recipe: 3.0 consistent → 3.8 noisy. Mentioning
quoting licensed quoting. Iterate recipes by re-derivation, not appended
caveats.

### "Do not ask the reviewer to re-run tests" — PROHIBITION WORKS (do not "fix" it)
Counter-example to the elephant effect: 0/5 violations with the prohibition
(vs 3/5 with no guidance; positive phrasing also 0/5 but longer). Discrete
directives without a competing model incentive hold fine. Kept as-is.
(micro-test 2, `/tmp/sdd-exp/micro2`; scoring required manual inspection —
two automated "violations" were the controller correctly quoting the rule.)

### File handoffs (task-brief + report files) — MECHANISM ADOPTED, SAVINGS SMALLER THAN MODELED
Briefs/report files were used 100% when templated, but dispatch prompts
only shrank ~9% (controller restates — see above) and tool-result chars
~16%. The resident-context savings modeled at ~50% materialized at ~$1/run.
Kept (harmless, fidelity anchor, enables the conflict-detection rule), but
not the big rock. The big rocks that remain: implementer turns (the actual
work), controller turn floor, review-loop count variance.

## Measurement traps logged
- Raw JSONL line counts overstate long-session turns 6-45% (compaction
  writes duplicate records). De-dup before counting.
- Automated violation-greps need per-match manual review (negation,
  rule-quoting).
- `coding-agent-tool-calls.jsonl` is finalized at run end; mid-run progress
  lives in the session transcript under `coding-agent-config/projects/`.
- Variant identification across parallel runs: grep the main transcript for
  the `/tmp/sdd-exp/<variant>` path (SUPERPOWERS_ROOT leaks into skill/tool
  paths).
