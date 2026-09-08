# Cancellable resumable imports

## Boundaries

`runImport` remains the shared execution path for CLI and worker imports.
`ImportStore` owns atomic row, checkpoint, count, and lifecycle persistence.
`ImportControl` remains the operator boundary for cancellation, status, and
resume authorization; it performs no import work. Existing callers without a
durable context retain their current one-shot behavior.

## Durable behavior

A durable import has a stable `importId`, source path and fingerprint, status,
last committed source position, and committed row count. Each batch transaction
stores rows, checkpoint, and count together. Resume validates source identity
and continues after the checkpoint. Cancellation is observed between batches;
completion and cancellation serialize to one durable outcome.

CLI and worker adapters use the same service and control boundaries. A durable
start creates or obtains an import ID, and adapters report the durable status
and imported count returned by the shared path. The exact identity-allocation
and result shapes are left for planning.

## Verification

Tests cover cancellation at batch boundaries, source mismatch, restart from the
last committed checkpoint, cancel-versus-complete races, CLI/worker parity, and
unchanged non-durable behavior.
