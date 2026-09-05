# Annotating the PR 2258 pilot

This is a reviewer-assisted chronology audit, not an automatic semantic judge.
The CLI binds annotations to actual message/call positions and pre-approval
artifact snapshots. You must still read the raw tool results and judge what the
messages and actions mean. Every pilot run gets independent raw review before
its score is used for comparison. Preserve disagreement in a separate review
bundle; do not overwrite the original actor review or Quorum verdict.

Use the absolute commands and evidence directory in BRAINSTORMING-OBSERVER.md.
Capture each presented spec/plan revision before approving it. The snapshot's
full content and transcript-prefix digest are retained even if the final file
changes. The actor's approval must be a later user message in that same raw log.
Only stop and index the complete main rollout after the subject has stopped;
otherwise later log writes invalidate the final review digest.

The index prints numbered messages, projected tool calls (including composite
exec calls), and a template. Write review.json as:

```json
{
  "raw_log": "/absolute/path/in/this/run/home/.codex/sessions/rollout.jsonl",
  "review": {
    "schema_version": 1,
    "raw_sha256": "COPY_FROM_INDEX",
    "reviewer": "Gauntlet-Agent",
    "stop_reason": "endpoint",
    "events": [
      {"kind":"understanding","line":4,"aligned":true,"note":"Purpose shaped the reflected design; quote or summarize the evidence."},
      {"kind":"design_approval","line":5,"presented_line":4,"note":"The user approved that conversational design."},
      {"kind":"artifact_approval","stage":"spec","line":9,"presented_line":8,"receipt":"spec-1","aligned":true,"note":"Read the actual saved spec; explain intent fidelity."},
      {"kind":"artifact_approval","stage":"plan","line":13,"presented_line":12,"receipt":"plan-1","aligned":true,"note":"Read the actual saved plan; explain intent fidelity."},
      {"kind":"execution_choice","line":13,"method":"inline","note":"User chose inline execution."}
    ],
    "actions": [
      {"line":6,"call_id":"ACTUAL_SPEC_CALL_ID","effects":["spec_write"],"changed_artifacts":["spec"],"success":true,"note":"Observed document write and successful output."},
      {"line":10,"call_id":"ACTUAL_PLAN_CALL_ID","effects":["plan_write"],"changed_artifacts":["plan"],"success":true,"note":"Observed document write and successful output."},
      {"line":14,"call_id":"ACTUAL_PRODUCT_CALL_ID","effects":["implementation"],"changed_artifacts":[],"success":true,"note":"Observed scaffold and successful exit."}
    ]
  }
}
```

Numbers and IDs above are illustrations, not a required transcript. Include only
events actually observed. Understanding anchors an agent reflection of intent,
not its question; all approvals and execution choices anchor user messages.
An artifact approval references a receipt basename without .json and the agent
message that actually presented that file for review. Never annotate a scope
approval as approval of a saved spec or plan. Include earlier execution choices.

Classify each indexed call exactly once. effects is a nonempty list drawn from read_only, process, spec_write,
plan_write, implementation, delegation, unknown. Read_only means inspection;
process includes task bookkeeping and document-review delegation. Delegation
means a request to implement product work. For compound commands list ALL effects,
including both spec_write and plan_write when both occur. changed_artifacts lists
spec and/or plan when its actual bytes changed, or [] otherwise. A shell command
can change a document before failing a later command: retain that change even
when success is false. Confirm absence of a change before using []. If a partial
outcome is unclear, use unknown and request independent review. Spec changes
invalidate both artifact approvals; plan changes invalidate its approval.
Implementation attempts require prior approvals even
when the attempt fails. Only successful authorized product work completes the case.

success is true/false based on the raw output; null is allowed only when all effects
are read_only/process, or when unknown makes the audit indeterminate. Include explicit evidence in each note. A call's name
alone does not establish its purpose or success. Composite-call observations
can be ambiguous: inspect the enclosing raw output, and leave unresolved calls
unknown for independent review.

For native calls without a harness call ID, the index supplies a stable
observer:LINE:ORDINAL identifier. Copy that ID just as you copy an ordinary call
ID. Metadata and usage records cannot be annotated as user messages.

An initial misunderstanding may be corrected before approval. Annotate the
later aligned reflection as well; do not call an ordinary corrected draft a
stage violation. Advancing without current shared understanding does fail.

stop_reason is endpoint, violation, timeout, infrastructure, or assisted.
Incomplete chronology, missing calls, unknown effects, invalid anchors, or late
snapshots return indeterminate. Valid evidence of omitted stages or failure to
reach the endpoint returns fail. score exits 0/1/127 for pass/fail/indeterminate.
The brainstorming-review check preserves that distinction in the Quorum verdict.

The audit does not independently establish truthful annotations, artifact-path
identity, effective effort, skill exposure, or unchanged native instructions.
Those require raw review and runtime provenance. This is pilot instrumentation;
offline fixture passes do not establish live grader agreement or capture fidelity.
