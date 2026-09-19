# Blinded Pairwise Handoff Judge

Use this contract after a matched RED/GREEN pair has produced two frozen specs.
Randomly label the artifacts A and B; do not reveal treatment identity to the
judge. Give the judge the fixture repository, both exact specs, and no producer
transcripts, self-ratings, per-run scores, or workflow verdicts.

Judge only which artifact better enables a fresh planning agent, given the
repository but no prior conversation, to write an executable implementation
plan without reconstructing design work or inventing binding decisions. Inspect
each artifact independently for repository-visible seams in product behavior,
public and internal interfaces, compatibility, ownership/concurrency, lifecycle
and recovery, transaction/atomicity boundaries, result propagation, and
verification. The list is a search map, not an answer key; report only gaps the
artifact and repository evidence support. Task sequencing, exact method names,
migration syntax, and other genuinely implementation-owned choices do not count.

Assess each artifact independently, then compare them directly. One burden is
one independent binding decision or piece of design reconstruction a planner
must resolve before it can specify implementation work. Assign each burden a
weight: 1 = minor, localized clarification or reconstruction; 2 = major,
unresolved binding decision or cross-component design uncertainty. Sum the
burden per artifact. A small but real reduction is
`A_BETTER` or `B_BETTER`; the better artifact need not close every seam or cross
an arbitrary score threshold. Choose `TIED` when neither materially reduces the
burden. Do not split one binding decision into several burdens, and do not infer
quality from length or polish.

Report burdens shared by both artifacts and burdens unique to either artifact.
Separate unique minor from unique major burdens. Also report independently
whether either artifact uniquely contradicts itself or departs from the settled
design. Do not infer which artifact is initial or final.

Return exactly:

```text
PAIRWISE_RESULT: <A_BETTER|B_BETTER|TIED>
PAIRWISE_REASON: <concise seam-level evidence>
A_BINDING_BURDENS: <none, or semicolon-separated burden=weight entries>
B_BINDING_BURDENS: <none, or semicolon-separated burden=weight entries>
SHARED_BINDING_BURDENS: <none, or semicolon-separated burdens>
A_UNIQUE_MAJOR_BURDENS: <none, or semicolon-separated burden=2 entries>
B_UNIQUE_MAJOR_BURDENS: <none, or semicolon-separated burden=2 entries>
A_UNIQUE_MINOR_BURDENS: <none, or semicolon-separated burden=1 entries>
B_UNIQUE_MINOR_BURDENS: <none, or semicolon-separated burden=1 entries>
A_TOTAL_BURDEN: <non-negative integer>
B_TOTAL_BURDEN: <non-negative integer>
A_UNIQUE_CONTRADICTIONS: <none, or concise evidence>
B_UNIQUE_CONTRADICTIONS: <none, or concise evidence>
A_UNIQUE_DESIGN_DRIFT: <none, or concise evidence>
B_UNIQUE_DESIGN_DRIFT: <none, or concise evidence>
PLANNING_OWNED: <concise details excluded from burden>
```

When running under Gauntlet, pass this complete block verbatim at the end of the
`reasoning` field in `report_result`; do not rely on free-form final text, which
the native result schema does not retain.

Workflow compliance is evaluated separately and cannot influence artifact
judgment. After the judgment is frozen, a separate post-reveal step maps A/B to
initial/final through the manifest. The bounded pass is GREEN when final total
burden is strictly lower, the final has no unique major burden, contradiction,
or design drift, and the producer run satisfies its workflow controls. A unique
minor final burden is permitted when total burden still falls. Byte-identical
restoration is a safe tie, not GREEN. A pair is clean corpus evidence only when
those conditions are independently evidenced.
