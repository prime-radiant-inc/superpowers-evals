# Retained conversation grading diagnostic

This dated experiment evaluates one held assessment instruction treatment on
five settled retained cases. The mechanical assessment contract is separately
selectable: Gauntlet attaches rubric text and derives status from ordered
criterion judgments; Quorum rejects a contradictory persisted status.

The [approved plan](../../superpowers/plans/2026-09-08-conversation-grading-contract.md)
sets the scope. [cases.json](cases.json) fixes identities, order, rubrics and gold.
The completed diagnostic and delivery evidence are recorded in [results.md](results.md).
The operator launches one assessment and exits; the coordinator inspects its
settlement and writes a semantic review before requesting the next ordinal.

| Ordinal | Case | Expected criteria | Derived status |
| --- | --- | --- | --- |
| 1 | claude-design | fail / fail / pass | fail |
| 2 | known-claude-design | pass / pass / pass | pass |
| 3 | known-codex-review | pass / pass / pass / pass | pass |
| 4 | codex-design | fail / fail / pass | fail |
| 5 | known-claude-review | pass / pass / pass / fail | fail |

Both reviews use the release's clarified `code-review-revised.md`. Known design
uses its release design rubric; later designs use their exact retained rubric.
Private publication anchors, corpus records, original audit and adjudication
remain separate from the complete assessor evidence indexes. All 672 indexed
files were authenticated; no earlier assessment or gold is supplied to the model.

## Fixed execution limits

- Five assessments, once each, in the declared order; serial execution.
- $4 observed stopping threshold, 45 minutes from first admission, and a frozen
  absolute cutoff. These are stopping limits, not hard provider billing caps.
- 120-second outer child deadline and the existing two-second termination cleanup;
  admission requires at least 122 seconds remaining.
- Grader: `anthropic.claude-sonnet-5`, existing `sonnet5_bedrock` route through the
  appliance's scoped Bedrock bearer and Mantle Anthropic endpoint.
- Frozen pricing: `docs/experiments/2026-09-06-pr2258-pricing/current.json`, SHA-256
  `6423a36bd98e01653824967834f114c71a1f4f03eeab595e511ad91a1ec37d8b`.

A valid wrong grade, unsupported rationale, or complete unclear result gets a
`semantic_miss` review. It permanently fails this prompt's promotion gate; the
remaining declared cases continue solely for diagnosis. An operational failure,
unknown/incomplete accounting, exhausted limit, or independently substantiated
gold ambiguity stops subsequent launches. Candidate disagreement alone does not
reopen gold. There are no retries, replacements, new conversations, rubric edits,
second candidate or additional allocation.

## Operator contract

Prepare a private immutable manifest outside a separate, initially empty 0700
experiment directory. It contains full clean Q/G source SHAs and canonical
absolute roots; the experiment directory and UTC cutoff; the fixed model and
pricing reference; hashed authentication references; and exactly five ordered
case rows. Each case row pins its rubric, evidence index, every indexed file and
scenario identity. `run.ts` defines the closed schemas. Gold remains outside the
manifest's model evidence paths.

Set pricing before starting Bun, because pricing initializes during imports:

```sh
OBOL_PRICING_DIR="$GRADING_Q_ROOT/docs/experiments/2026-09-06-pr2258-pricing" \
  bun "$GRADING_Q_ROOT/docs/experiments/2026-09-08-conversation-grading/run.ts" \
  --execute /absolute/private/manifest.json 1
```

Production loads the existing conversation-assessment pilot config for ownership
and credential projection. It uses the shared spend lease and refuses occupied
appliance locks or unresolved durable campaign claims. Source snapshots are staged
in new worktrees; no image build, registration or existing source selection is
needed for this direct retained assessor. Use the established detached appliance
launch pattern so an SSH disconnect does not own the child's lifetime. Preserve
the launch PID/start-ticks/boot receipt and private log, then poll settlement.

The experiment directory holds `window.json` and `01` through `05` directories.
Each ordinal has an exclusive `launch.json`, the normal Gauntlet output directory,
`settled.json`, and a coordinator-written `review.json`. Settlement retains process
outcome, exact result/run/usage digests, returned-turn coverage, known cost and any
operational error. Missing or changed receipts, skipped/duplicate ordinals, or an
unfinished launch refuse further execution. This diagnostic has no resume path.

Write the review after inspecting the actual result against settled gold:

```json
{
  "result_sha256": "<exact result.json SHA-256 from the settlement>",
  "decision": "match",
  "rationale": "<short evidence-based explanation>"
}
```

`decision` is `match` or `semantic_miss`. Review publication must be exclusive;
existing reviews and results are never overwritten. A substantiated gold stop is
recorded separately in `stopped.json` with its evidence references. The next
invocation revalidates prior result/log bytes, review binding and complete pricing
before admitting exactly one child.

## Interpretation and delivery

Five completed assessments finish the diagnostic. The semantic prompt is eligible
only if all five independent reviews find supported matches. Mechanical code can
ship after its independent offline gates even if this prompt fails. Retain the
candidate branch and negative results; no second treatment follows automatically.

This is a candidate-only retained regression exercise. It does not establish
repeatability, causal improvement, general grading reliability, or qualification
for debugging/test-history scenarios. Main/CI and canonical campaign-source
installation are separate evidence from these assessments. The legacy generic
image's baked Gauntlet is a separate deployment surface and is not rebuilt here.
