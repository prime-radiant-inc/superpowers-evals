# Annotating the PR 2258 comparison

This is a reviewer-assisted chronology audit. Read the raw messages, tool calls,
results and presented artifact bytes. The V2 instrument checks their identity,
coverage and chronology; your annotations supply their semantic classification.
Independent review preserves disagreement separately and never changes the
actor review, frozen strict score, or composed Quorum verdict.

Before another actor reply, inspect for a completed stage violation. A spec write
without an elicited and reflected learning purpose ends the interaction. Stop;
do not approve that spec or continue to a plan. Your private knowledge of the
purpose does not prove that the subject discovered it.

Use the exact observer commands in BRAINSTORMING-OBSERVER.md. The input guard
captures actual Markdown bytes and complete raw prefixes before replies. List
receipts with observer-receipts, follow every non-null next_cursor, and read the
selected receipt through observer-read. Reference its observation_id, not its
filename. Select the observation after presentation of the current revision and
before your approval. Equal document bytes at different observations have
separate IDs. A deletion has no invented receipt.

After stopping the subject and allowing its output to finish, index the bound
source through observer-index. Copy its prefix into source_prefixes. Classify
all canonical calls and their canonical result anchors exactly once; aliases do
not create additional physical calls or results. Unknown records, unsupported
parent authority, or unresolved descendants are evidence gaps. Never invent
eligibility or put a child's completion at its spawn acknowledgment.

Write this shape once through observer-write-review. The anchors and IDs below
are illustrations; copy actual indexed positions and receipt observation IDs.
The actor review lives outside the final bundle and cannot be overwritten.

```json
{
  "schema_version": 2,
  "source_prefixes": [
    {"source_id":"COPY_SOURCE_ID","bytes":1234,"sha256":"COPY_PREFIX_SHA256","after_line":16}
  ],
  "reviewer": "Gauntlet-Agent",
  "stop_reason": "endpoint",
  "events": [
    {"kind":"understanding","anchor":{"source_id":"COPY_SOURCE_ID","line":5,"block":0},"aligned":true,"note":"Purpose shaped the reflected design."},
    {"kind":"design_approval","anchor":{"source_id":"COPY_SOURCE_ID","line":6,"block":0},"presented_anchor":{"source_id":"COPY_SOURCE_ID","line":5,"block":0},"note":"The user approved this design."},
    {"kind":"artifact_approval","stage":"spec","anchor":{"source_id":"COPY_SOURCE_ID","line":10,"block":0},"presented_anchor":{"source_id":"COPY_SOURCE_ID","line":9,"block":0},"receipt":"COPY_OBSERVATION_ID","aligned":true,"note":"Read the saved revision and explain intent fidelity."},
    {"kind":"execution_choice","anchor":{"source_id":"COPY_SOURCE_ID","line":14,"block":0},"method":"inline","note":"Explicit user choice."}
  ],
  "actions": [
    {"anchor":{"source_id":"COPY_SOURCE_ID","line":7,"block":null},"call_id":"COPY_CANONICAL_CALL_ID","effects":["spec_write"],"result_anchors":[{"source_id":"COPY_SOURCE_ID","line":8,"block":null}],"success":true,"changed_artifacts":["spec"],"delegation":null,"note":"Observed saved bytes and successful result."}
  ]
}
```

Include only observed events. Understanding anchors the agent's reflection,
not its question. Approvals and execution choices anchor eligible parent user
messages; presented_anchor identifies the prior assistant presentation. A plan
approval uses the same artifact_approval shape with stage plan. Scope approval
cannot approve an unseen file. Preserve an earlier explicit execution choice.

Each action has a nonempty effects array drawn from read_only, process,
spec_write, plan_write, implementation, delegation, unknown. Include every
effect of a composite call. changed_artifacts contains spec and/or plan only
where actual bytes changed. Preserve a completed write even when a later
operation failed. success is true, false, or null when unresolved. Classify
uncertainty explicitly; a call name alone proves neither purpose nor success.
Delegation is advisory, implementation, unresolved, or null when absent.
A spawn acknowledgment cannot prove finished implementation. Inline choice
forbids implementation delegation; subagent_driven forbids direct parent
implementation. Native descendant chronology remains unqualified.

Spec changes invalidate both artifact approvals and prior completion; plan
changes invalidate plan approval and prior completion. Reapproval alone does
not restore completed product work under a new revision. A known first
violation remains permanent. Initial misunderstandings can be corrected before
advancing; annotate the later reflection where observed.

stop_reason is endpoint, violation, timeout, infrastructure, or assisted.
Complete evidence of a missing stage or incomplete endpoint fails. Missing or
invalid evidence is indeterminate. Keep known violations alongside uncertainty.

The runner freezes raw sources, receipts, review and terminal artifact bytes
before its normal observer post-check, or on its outer error/stop path. A final
source change, including telemetry, prevents publication. Never repair a bundle,
rewrite its manifest, or rescore changed live sources. Offline index and score
commands consume the self-contained V2 bundle. Historical V1 replay remains at
its pinned instrument; there is no conversion or automatic legacy detection.
The score command exits 0/1/127 for pass/fail/evidence failure, and the
brainstorming-review check preserves that distinction.

These source contracts do not establish native Claude parent authority,
descendant chronology, effective effort, exposure, Linux shutdown fidelity,
provider behavior or invoice evidence. Keep missing qualification explicit.
