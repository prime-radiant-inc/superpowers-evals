# Decouple the dashboard into a read-only workspace package

**Date:** 2026-06-18
**Status:** design approved; pending implementation plan

## Goal

Break the web dashboard out of the quorum harness into its own directory tree
with a **cleanly enforced, one-directional boundary**. The split is **harness ⇄
dashboard** (not "core ⇄ dashboard"): the harness runs evals and writes
`results/`; the dashboard only *visualizes* what's on disk. After this change the
dashboard depends on **nothing** from the harness — the filesystem is the only
contract between them.

## Non-goals

- Not decomposing the harness itself into packages (it stays one root package).
- Not changing how evals run, capture, price, or grade.
- Not building a remote/hosted dashboard, auth, or a new UI. Same UI, same
  Bun.serve server, same SSE live-update model — just relocated and read-only.
- Not preserving the dashboard's ability to *launch/stop* evals (removed; see
  below).

## Decision

**Approach: the dashboard becomes an isolated Bun-workspaces package; the harness
stays at the repo root.** The dashboard package declares zero dependency on the
harness, so it structurally cannot import harness code (resolution fails) — the
boundary is enforced by the package graph, not by lint.

### Rejected alternatives

- **Full monorepo (`packages/harness` + `packages/dashboard`).** Strongest
  enforcement but churns the entire repo (every harness path, tsconfig, biome,
  CI, the `quorum` bin) to separate a thing that is already a leaf. The work
  lands on the harness, which isn't what's being decoupled. Rejected as
  over-scoped; this layout can still be reached later by moving the root into
  `packages/harness` if a second harness-side package ever appears.
- **Dir move + lint-enforced import boundary (stay single-package).** Lightest,
  but enforcement is lint/CI (bypassable), not structural. Rejected because the
  explicit ask is an *enforced* boundary.

## Why this is cheap: the coupling is almost entirely the launch path

Current dashboard coupling (audited 2026-06-17):

- **Read side — already decoupled.** `scan.ts`/`view.ts` read `results/*/verdict.json`
  off the filesystem with the dashboard's own narrow type (`DashboardVerdict` /
  `parseDashboardVerdict`). No harness behavior is imported to read state.
- **Launch side — the only real coupling.** `orchestrator.ts` reaches into
  `run-all/` (`invokeChild`, `stopBatch`, `batch-index`, `matrix`),
  `scheduler/` (`runSchedule`, `RealClock`), and `agents/antigravity.ts`
  (`ANTIGRAVITY_RATE_LIMIT_MARKER`). `server.ts`/`index.ts` thread an `InvokeFn`.
- **Reverse deps — one.** Only `src/cli/index.ts` imports `startDashboard`.

Going read-only means the launch coupling is **deleted, not re-interfaced.**

## Target structure

```
evals/
  package.json            # root = harness "quorum"; adds workspaces: ["packages/dashboard"]
                          #   + script "dashboard": run the dashboard entrypoint
  src/                    # harness (unchanged) — runner, scheduler, run-all,
                          #   capture, composer, economics, obol, checks, agents,
                          #   normalize, contracts, cli (minus the dashboard subcommand)
  scenarios/             # read by the dashboard for the full grid (optional input)
  coding-agents/         # read by the dashboard for the full grid (optional input)
  results/               # written by the harness; read by the dashboard (the contract)
  packages/
    dashboard/
      package.json        # @quorum/dashboard, private; deps: bun types, zod (if kept); NO quorum dep
      tsconfig.json
      biome config (or inherits root)
      src/                # scan, view, templates, event-bus, server, index, contracts, static
      test/               # the dashboard's tests
```

## What gets deleted (the decoupling)

- `orchestrator.ts` — launch/stop over the scheduler. Deleted.
- The launch/stop HTTP routes in `server.ts`; the `InvokeFn` parameter on
  `startDashboard`/server. Deleted.
- Every cross-import that rode with them: `run-all/*`, `scheduler/*`,
  `agents/antigravity.ts`, `contracts/batch.ts`, `invariant.ts` (re-add a
  one-line local `invariant` in the package if still needed). Net harness imports
  after the cut: **none**.

## The filesystem contract + graceful grid derivation

The dashboard is pointed at a results directory and renders the scenario×agent
grid. Grid sources, in degrading order:

1. **Observed cells (always):** derived from `results/` — every run dir
   contributes its `(scenario, agent)` cell and latest `verdict.json`. With only
   `results/`, the grid shows exactly the cells that have runs.
2. **Full grid (when available):** if `scenarios/` and `coding-agents/` are
   resolvable (the dashboard is pointed at, or can find, the evals repo), the
   full scenario×agent axis is read from them so empty `not_run` cells also
   appear. This replaces today's `run-all/matrix.ts` import with a filesystem
   read local to the dashboard.

**Graceful:** missing `scenarios/`/`coding-agents/` is not an error — the
dashboard falls back to results-only. This is what makes the viewer portable to a
bare results directory.

Read types stay local to the dashboard (the on-disk JSON is the contract; the
dashboard narrows it defensively, as it already does for `verdict.json`). No
shared types package is introduced (YAGNI).

The SSE event-bus and the ~1s scanner loop are kept unchanged — live updates come
from re-scanning `results/` on disk, which needs no harness code.

## Invocation

- Standalone entrypoint:
  `bun packages/dashboard/src/index.ts --results <dir> [--port N] [--root <evals-repo>]`
  Defaults: `--results results/`, `--root` = cwd (used to find `scenarios/` +
  `coding-agents/`; if they're absent, results-only mode).
- Root convenience: `bun run dashboard` runs the entrypoint (a script invocation,
  not a code import — keeps the harness free of any dashboard dependency).
- `quorum dashboard` subcommand is **removed** from the harness CLI, along with
  the `startDashboard` import. The harness no longer references the dashboard.

## Tooling

- Root `bun run check` runs the harness's biome + tsc + bun test **and** the
  dashboard package's biome + tsc + bun test (e.g., a root script that runs both,
  or `bun test`/biome/tsc invoked per workspace). Both must be green.
- `bun run quorum check` (scenario validation) is unaffected.
- Per-package tsconfig: the dashboard gets its own `tsconfig.json` (it no longer
  shares the harness's module graph).

## Testing

- Dashboard tests for `scan`/`view`/`templates`/`event-bus` move to
  `packages/dashboard/test/` and keep passing.
- Tests covering `orchestrator`/launch are deleted with the code.
- Add a test for the new grid-derivation: (a) results-only mode shows only
  cells with runs; (b) full mode (with `scenarios/`+`coding-agents/`) shows
  not-run cells too.
- Harness `bun test` no longer includes dashboard tests; they run under the
  dashboard package.

## Migration — two steps, each green before the next

1. **Decouple in place** (no files move yet). In `src/dashboard/`: delete
   `orchestrator.ts` + the launch/stop routes + the `InvokeFn` threading; derive
   the grid from the filesystem (results-only + optional full grid); remove the
   `quorum dashboard` subcommand and its `startDashboard` import; add the root
   `dashboard` script + standalone entrypoint flags. `bun run check` green. This
   proves the decoupling with the code still in place.
2. **Extract to a package.** Move `src/dashboard/` → `packages/dashboard/src/`
   and its tests → `packages/dashboard/test/`; add `packages/dashboard/package.json`
   (no quorum dep) + `tsconfig.json`; add `"workspaces": ["packages/dashboard"]`
   to the root; point the root `dashboard` script at the package entrypoint;
   wire root `bun run check` to cover both. Root check green.

Doing step 1 first means the risky part (removing behavior, re-deriving the grid)
is validated before the mechanical move, and the move itself is then a no-logic
relocation.

## Self-review notes

- Scope is one refactor (relocate + read-only), single plan. No decomposition
  needed.
- The one judgment call already made: the dashboard loses in-UI launch/stop
  (read-only). Launching stays in the harness/CLI.
- Enforcement is structural (package graph), per the "enforced boundary" ask;
  lint-only was rejected.
- Graceful degradation (results-only when the repo isn't present) is explicit, so
  the viewer is portable to a bare results dir.
- No shared-types package (YAGNI) — the on-disk JSON is the contract; the
  dashboard narrows it locally, as it already does.
