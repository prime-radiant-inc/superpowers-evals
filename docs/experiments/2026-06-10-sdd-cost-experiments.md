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

### writing-plans "No Placeholders" variants — CANNOT ELICIT (leave section alone)
40 opus-written plans (20 unpressured 3-task, 20 pressured: 10 tasks, five
near-identical, ~2,500-word economy target) across four guidance variants
including a no-guidance control: zero real placeholder patterns. The only
regex hit was a self-review attesting none exist. The failure mode the
banned-patterns list guards against does not occur in current opus;
variants are indistinguishable at zero. Inconclusive-by-zero ≠ pass: kept
the existing section (cheap insurance), declined the rewrite PR. Relocation
design preserved in the positive-instruction spec for future model
generations.

## Batch A-E (2026-06-10/11 overnight; strict-cost ladder probes)

Runs launched up to 7-way parallel — wall-clock numbers carry that load;
tokens/$ are the trustworthy metrics. Coding-agent figures quoted.
Run mapping: `/tmp/sdd-exp/batch-AE-runs.md` (scratch).

### A. Lean-vs-combo brief isolation — COST-NEUTRAL (briefs stay, justified by fidelity not dollars)
Lean = branch HEAD minus the task-brief/report-file mechanism (model
lines, review packages, ledger, recipes all kept). Lean fractals ×3:
$11.61 / $12.27 / $13.25 (mean $12.38); same-night combo control $14.10;
historical combo band $11.67-14.84 (n=8). Entirely overlapping. The
file-handoff machinery neither costs nor saves measurable money on a
10-task scenario; its case is requirements fidelity (exact values come
from the brief), the conflict-detection rule, and compaction durability.
Resolves the open "was e355795-minus-briefs the better config" question:
no — that 44.4-min run was a tail draw.

### B. Crisp-plan ceiling (strict-cost L1) — VALIDATED IN EFFECT
New scenario `sdd-go-fractals-crisp`: same project, plan hand-rewritten
10 → 7 right-sized tasks + `## Global Constraints` header + per-task
`Interfaces:` lines. Crisp ×3 on combo config: $9.51 / $12.65 / $12.65
(mean $11.60), gates 3/3. Mechanism: 20/21/24 dispatches (7 implementers
each) vs combo's 28 (10 implementers, 13 reviews); fix waves flat
(5/6/9 vs 7) — Interfaces lines + constraints header held review loops
down despite coarser tasks. ≈ −$1.5/run mean at fractals scale.
Open half: eliciting such plans from writing-plans guidance (validated
by hand-crisped plan only) — that's the L1 follow-up PR's burden.

### C. Sonnet controller (strict-cost L2 recon) — $6.68 / $8.05, judgment promising
claude-sonnet coding-agent (`--model sonnet` launcher). Run 1: PASS all
gates, 31 min / 12.6M / **$6.68** — half the combo band, fastest fractals
measured. Run 2: PASS, 40.8 min / 16.1M / $8.05 — n=2 lands ~40% below
the combo band with tokens inside it (no cheap-controller turn
inflation). 26/26 and 31/31 dispatches model-explicit; haiku tiered in
for mechanical fixes + README (10/31 dispatches in run 2 — heavier and
saner tiering than opus controllers showed); review loops, per-task
Important→fix→re-review, omnibus final fixer all followed in both runs. Judgment audit
(narrative): caught a fixer side-effect (`go mod tidy` removed cobra)
and re-fixed before re-review — genuine cross-check. Caveats: zero
BLOCKED/⚠️ events arose, so the audit could not stress the escalation
points; final review ran on sonnet, not opus (tier note). NOT a license
to ship L2 — the spec's full N=5 + judgment-audit gates still apply.

### D. Haiku task reviewers (strict-cost L3) — DEAD, as pre-registered
Forcing config: Model Selection rewritten to put task reviewers on the
cheapest tier. Planted-defect scenario ×5 (baseline config: 5/5 pass):
**2 pass / 1 indeterminate / 2 fail.** Across 10 planted defects the
per-task haiku reviewer cleanly flagged ZERO at correct severity:
1 found-but-downgraded ("the brief explicitly specifies it" — the
exact rationale the prompt prohibits), 9 missed or rationalized.
Sharpest finding: haiku does not fail silent — it **advocates** for
defects (praised the DRY violation as YAGNI; called the assert-nothing
test plan-compliant), manufacturing justifications that can mislead the
controller. Every passing run survived on opus-controller redundancy or
the final review, i.e. the pass/fail gate masks the reviewer failure —
which is why L3's acceptance was defined per-reviewer, not per-run.
Mechanical cheapness (3-turn reviews) does NOT make review decisions
mechanical. Do not re-propose without a structurally different design
(e.g. haiku pre-screen + escalation, which is a new experiment, not
this one).

### E. Svelte n=2 — combo claim becomes an honest (wide) range
Second combo svelte run: PASS, 69 min / 24.1M / $20.30 (run 1: 55.0 min
/ 19.3M / $14.99; baseline n=1: 79.7 / 27.3M / $20.98). Driver: 9 fix
waves across 12 tasks (run-to-run review-strictness variance), 34/34
dispatches model-explicit. PR claim must read: time/tokens clearly
better, cost $14.99-20.30 vs $20.98 — overlapping at the top.
Deviation logged: controller dispatched fixes without re-review
dispatches afterward (judgment-audit candidate).

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
