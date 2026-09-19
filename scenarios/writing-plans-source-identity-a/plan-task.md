# Cancellable resumable imports

Add operator cancellation to durable batch imports. A running import can be
cancelled from either the CLI or background-job system, must stop at cooperative
batch boundaries without losing committed progress, and can later be resumed
explicitly after process or machine restart.

Committed rows must never be silently skipped or duplicated. Resume must refuse
changed source content or changed parser semantics. CLI and worker use the same
behavior; existing callers that do not opt into durable resume retain current
one-shot behavior. Status and outcomes report truthful cumulative committed
counts. Cancellation racing with completion produces exactly one durable
terminal outcome. Recovery of an import that never reached `cancelled`, remote
storage, parallel import, and parser changes are out of scope.
