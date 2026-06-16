# run-all resilience: graceful shutdown, liveness heartbeat, zombie reaping

Status: approved (Jesse, 2026-06-15)

## Motivation

Batch `batch-20260616T033204Z-f4bd` (`--tier sentinel`, 5 agents, `--jobs 4`)
was expected to run 44 pairs but only 26 completed. Root-cause analysis showed:

- The matrix selection was correct: 44 runnable, 241 skipped.
- run-all ran cells 1–26 (a clean prefix of the runnable set) to completion,
  then the process **died ~21 minutes in (20:53 PDT) while parked idle** waiting
  for in-flight children, before dispatching the final 18 cells.
- `batch.json` has `finished_at: null`: run-all died before
  `runSchedule().done` resolved, so `writeBatchFooter` never ran.
- Four children were orphaned. One (codex `triggering-finishing`) finished at
  20:54:59 — after run-all was gone — wrote a full `verdict.json`, and was never
  recorded (wasted, unrecorded token spend).
- Not OOM (`memory.events` `oom_kill 0`, `memory.max max`). Not the dead
  `--no-cursor` flag. Not a scheduler bug (the dispatch frontier was correctly
  at cell 29 with 4 in flight).

run-all has **no signal handling**. An idle, parked async process does not
self-terminate, and a child outlived it, so an external signal killed run-all
alone — most likely **SIGHUP** from the foreground `docker exec` session (no
TTY, no signal proxy) going away.

Two latent issues compounded it: the container's PID 1 is `sleep infinity`,
which never reaps orphans (dozens of `<defunct>` processes accumulate); and
there is no liveness signal, so a stalled or dying batch looks identical to a
healthy one.

## Design

### Part 1 — Graceful shutdown

`runBatch` installs handlers for **SIGINT, SIGTERM, and SIGHUP**. On any of
them it runs one stop routine, mirroring the dashboard `/stop` path that already
works (`dashboard/orchestrator.ts`):

1. `handle.requestStop()` — the scheduler eager-skips every undispatched cell as
   `stopped`.
2. `process.kill(pid, 'SIGINT')` for each tracked in-flight child pid, ESRCH
   swallowed. **SIGINT, not SIGTERM**: the runner (`cli/index.ts`,
   `runner/stopped.ts`) has a graceful SIGINT handler that forwards SIGINT to
   gauntlet and writes a `stopped` (indeterminate) verdict. So in-flight runs
   stop immediately *and* are recorded — no lost verdict.
3. Children settle → their `cell_finished` events are recorded → `done`
   resolves → the footer is written normally, with accurate counts.
4. A **second signal** triggers a hard `process.exit` so the operator is never
   stuck behind a wedged child.

Child pids are tracked by wrapping the scheduler's `invoke` to register each
child's pid (via the existing `onPid` hook run-all never used) into a `Set`,
removed when that child's invoke settles.

The pid-tracking wrapper and the SIGINT-stop routine are the same logic the
dashboard orchestrator already embeds, so they are extracted into a shared
module (`src/run-all/child-stop.ts`) used by both run-all and the orchestrator.

### Part 2 — Periodic heartbeat

run-all maintains a running set: add on `cell_started`, remove on
`cell_finished` / `cell_skipped`. A timer fires every `--heartbeat-seconds`
(default 30, `0` disables) and prints one append-only line:

```
⋯ 20:53:10 · running 4/4 · done 12 · queued 18 · [claude:triggering-test-driven-development, codex:triggering-finishing, …]
```

Timer-driven, so it keeps printing even if dispatch stalls (a stall shows the
same in-flight cells sitting across successive heartbeats). The timer is cleared
in the same `finally` as the signal handlers. A pure `heartbeatLine(...)`
formatter is unit-tested; the `setInterval` glue stays thin.

### Part 3 — Container zombie reaping

Add `--init` to the `docker run` in `scripts/evals-container` (`run_up`) so
Docker runs tini as PID 1 — reaping orphans and forwarding signals. Takes effect
on the next container create (`down` + `up`); the current zombie pile clears on
recreate. Part 1 prevents orphaning in the graceful case; `--init` is the safety
net for the ungraceful case (run-all SIGKILLed, or exec disconnect before the
handler runs). Different failure modes; both wanted.

## Out of scope (YAGNI)

- Drain-with-timeout and a SIGKILL escalation ladder beyond the second-signal
  hard-exit.
- Batch resume. The run is not resumable; re-running with a `--scenarios` filter
  covers the missing cells. A follow-up if wanted.

## Testing

- Shared helper: pid registered via wrapped invoke, removed on settle; stop
  routine calls `requestStop` and SIGINTs each pid; ESRCH swallowed.
- run-all: footer written when a signal fires mid-drive; in-flight cells recorded
  as their settled verdict.
- Heartbeat: `heartbeatLine` formatter; running-set bookkeeping across
  start/finish/skip events; CLI accepts `--heartbeat-seconds` and rejects bad
  values.
- Container `--init`: verified by recreate → `ps -p 1` shows tini → an orphan is
  reaped.
- `bun run check` and `bun run quorum check` green.

## Commits

1. shared pid-stop helper + run-all graceful shutdown
2. heartbeat
3. container `--init`
