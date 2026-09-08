# Cancellable Resumable Imports

## Goal

Add operator cancellation to durable batch imports without losing committed
progress. CLI and background jobs use the same import service and can resume a
cancelled import explicitly after process or machine restart. Existing callers
that do not opt into durable resume retain one-shot behavior.

## Durable model

An opted-in import is identified by an `importId` (the background job ID). Its
durable record stores:

- lifecycle status: `running`, `cancellation_requested`, `cancelled`,
  `completed`, or `failed`;
- source locator, source content fingerprint, and parser profile;
- last committed record checkpoint and cumulative committed row count;
- cancellation request metadata when present.

The checkpoint is the last record position whose rows were committed. Rows,
checkpoint, and cumulative count are written in one transaction. A checkpoint
is therefore never advanced without its rows, and resume starts strictly after
that position.

## Execution flow

The shared import service owns durable start/resume orchestration. For a
durable import it validates the source fingerprint and parser profile before
loading the checkpoint. A new run starts at position zero; an explicit resume
is permitted only from `cancelled`, revalidates identity/profile, and starts
after the saved checkpoint.

Each batch is committed atomically through `ImportStore`. At every batch
boundary, including before starting the next batch, the service polls durable
status. If status is `cancellation_requested`, it conditionally transitions to
`cancelled` and returns the cumulative committed count. Otherwise it continues.
After the final batch it conditionally transitions to `completed` and returns
the same cumulative count.

Cancellation is cooperative: the batch already in its database transaction
finishes, while no subsequent batch begins after cancellation has been
observed. A cancellation request changes only `running` to
`cancellation_requested`; it does not remove rows or checkpoints.

## Control and entry points

`ImportControl` remains the operator boundary. Its cancellation operation
durably requests cancellation, and its status operation exposes the lifecycle
state and cumulative progress. Requests for imports that are not `running`
report the existing status rather than claiming acceptance.

The CLI gains durable import identity and an explicit resume operation (for
example, `import --import-id ID` and `resume --import-id ID`). Its cancellation
command uses `ImportControl`; cancellation output and import output must report
the truthful durable state and cumulative count.

The worker keeps staging uploads and resolving parser profiles in the worker
adapter. It uses the job ID as `importId`, and a later job attempt must
explicitly indicate resume. It records the source revision and the durable
terminal outcome, including cumulative committed count. A changed upload
fingerprint or parser profile causes an explicit resume refusal; it must not
continue against different content or parsing rules.

## Concurrency and terminal races

Cancellation and completion use conditional database transitions. Whichever
terminal transition commits first wins: the import ends either `cancelled` or
`completed`, never both. The losing operation re-reads and reports the durable
terminal state. Resume and cancellation are likewise guarded by valid-state
transitions so stale attempts cannot restart or cancel a terminal import.

## Failure and compatibility

Unexpected failures preserve the last committed rows/checkpoint and transition
the durable import to `failed` with an actionable error outcome. They do not
pretend that uncommitted records were imported. Non-durable callers continue to
use the existing service path without lifecycle, checkpoint, or cancellation
requirements.

## Acceptance criteria

- A cancellation observed at a boundary leaves all previously committed rows
  and the matching checkpoint intact.
- Status exposes `cancellation_requested` while the current batch is finishing
  and `cancelled` afterward.
- Explicit resume continues from the durable checkpoint and reports cumulative
  committed progress.
- Source fingerprint or parser-profile changes reject resume explicitly.
- Cancellation/completion races produce exactly one durable terminal outcome.
- CLI and worker durable imports share these semantics; legacy one-shot calls
  remain unchanged.
- Tests cover batch atomicity, boundary cancellation, restart/resume, identity
  validation, lifecycle transitions, race resolution, and truthful counts.
