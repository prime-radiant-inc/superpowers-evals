# Approved cancellable-import design

The import remains split across the repository's existing boundaries:

- `runImport` performs import work for both CLI and worker entry points;
- `ImportStore` owns durable rows, checkpoints, counts, and state transitions;
- `ImportControl` accepts operator cancellation/status/resume authorization but
  never imports records or dispatches execution itself;
- CLI and worker adapters explicitly dispatch the shared service after control
  authorization.

Durable imports use a stable `importId`, preserve committed rows and checkpoint
at every batch boundary, reject changed source identity, and report cumulative
committed count. Cancellation and completion serialize to one durable outcome.
Resume is explicit; existing non-durable callers retain their current behavior.

The implementation plan may choose method names, SQL syntax, and CLI spelling.
It may not move import execution into the control boundary or create an
automatic resume workflow.
