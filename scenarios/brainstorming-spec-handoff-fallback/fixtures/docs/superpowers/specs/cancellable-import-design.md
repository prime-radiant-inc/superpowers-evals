# Cancellable resumable imports

## Boundaries

`runImport` remains the shared execution path for CLI and worker imports.
`ImportStore` owns atomic row, checkpoint, count, and lifecycle persistence.
`ImportControl` owns cancellation, status, and resume. Existing callers without
a durable context retain their current one-shot behavior.

## Durable behavior

A durable start atomically creates a unique `importId` before dispatch. The
record stores source path and fingerprint, status, last committed source
position, and cumulative committed row count. Each batch transaction stores
rows, checkpoint, and count together. Resume validates source identity and
continues after the checkpoint. Cancellation is observed between batches;
completion and cancellation serialize to one durable outcome.

`ImportControl.resume(importId, source)` validates the persisted identity,
transitions the import back to `running`, invokes `runImport` directly, waits for
the import to finish, and returns its final durable outcome. Both CLI and worker
call this operation, so the exact public result is always
`{ importId, status, importedCount }`, where `importedCount` is cumulative across
attempts. The control layer therefore owns the complete explicit-resume flow.

## Verification

Tests cover cancellation at batch boundaries, source mismatch, restart from the
last committed checkpoint, cancel-versus-complete races, CLI/worker parity, and
unchanged non-durable behavior.
