# Batch import fixture

This small application imports records through one shared service. The command
line entry point and the background worker both depend on that service. A
separate import-control boundary accepts operator commands and reads durable
status; it does not perform import work itself.

The current import is deliberately non-resumable. Callers may choose a batch
size, but an interrupted invocation starts again from the beginning.

CLI callers supply a persistent local path. Background jobs keep one job ID but
resolve the current upload revision and stage it to a temporary path for each
attempt. The worker records that revision with its ordinary completion outcome.
CLI parsing is selected by command options; each worker job stores and resolves
its parser profile. `FileImportSource` exposes its locator and can fingerprint
the contents it was given. The current `import_jobs` record stores one source
locator.

Repository rules:

- Keep the CLI and worker on the shared import service.
- Keep operator commands on the shared import-control boundary.
- Keep worker staging mechanics in the worker adapter.
- Preserve the behaviour of callers that do not opt into durable resume.
- Preserve truthful terminal status and imported-count reporting to both entry
  points.
- Database changes follow the numbered files under `migrations/`.
- `npm test` is the canonical verification command.
