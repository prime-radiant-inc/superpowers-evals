# Batch import fixture

This small application imports records through one shared service. The command
line entry point and the background worker both depend on that service. A
separate import-control boundary accepts operator commands and reads durable
status; it does not perform import work itself.

The current import is deliberately non-resumable. Callers may choose a batch
size, but an interrupted invocation starts again from the beginning.

Repository rules:

- Keep the CLI and worker on the shared import service.
- Keep operator commands on the shared import-control boundary.
- Preserve the behaviour of callers that do not opt into durable resume.
- Preserve truthful terminal status and imported-count reporting to both entry
  points.
- Database changes follow the numbered files under `migrations/`.
- `npm test` is the canonical verification command.
