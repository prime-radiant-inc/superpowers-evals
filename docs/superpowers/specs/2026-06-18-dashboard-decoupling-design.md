# Decouple the dashboard into a read-only workspace package

**Date:** 2026-06-18
**Status:** design approved; revised after adversarial (`/par`) review; pending implementation plan

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
- Not building a remote/hosted dashboard, auth, or a new UI. Same Bun.serve
  server, same SSE live-update model — relocated, read-only, with the launch UI
  removed.
- Not preserving the dashboard's ability to *launch/stop* evals (removed).
- Not preserving the dimmed **n/a** cell categorization (see "Grid").

## Decision

**Approach: the dashboard becomes an isolated Bun-workspaces package; the harness
stays at the repo root.** The dashboard package declares zero dependency on the
harness, so it structurally cannot import harness code (resolution fails) — the
boundary is enforced by the package graph, not by lint.

### Rejected alternatives

- **Full monorepo (`packages/harness` + `packages/dashboard`).** Strongest
  enforcement but churns the entire repo to separate a leaf. Over-scoped;
  reachable later by moving the root into `packages/harness` if a second
  harness-side package appears.
- **Dir move + lint-enforced boundary (single package).** Enforcement is
  lint/CI (bypassable), not structural. The ask was an *enforced* boundary.

## The coupling, corrected (was wrong in v1 — `/par` caught it)

v1 claimed the read side was already decoupled and only `orchestrator.ts`
touched the harness. That is **false**. Deleting `orchestrator.ts` removes the
launch coupling (`run-all` `invokeChild`/`stopBatch`/`batch-index`, `scheduler`
`runSchedule`/`RealClock`, `agents/antigravity.ts`), but several **read-path**
harness imports survive and must also be removed/replaced:

- `server.ts` → `buildMatrix` (`run-all/matrix.ts`) and `runnable` /
  `SkippedReason` (`contracts/batch.ts`), used by `launchInfo()` which is called
  from the `GET /` read route (`renderRoot`) to compute the dimmed **n/a** cells.
- `index.ts` → `knownAgentNames` (`run-all/matrix.ts`), used to seed the agent
  list `parseRunDirName` needs.
- `templates.ts` → `assertNever` (`invariant.ts`).

So "net harness imports: none" is the *target*, reached only after replacing all
of the above — not a free consequence of deleting the orchestrator.

Reverse deps remain one: only `src/cli/index.ts` imports `startDashboard`.

## Grid derivation (decision: drop n/a, keep full grid)

The dashboard renders a scenario×agent grid. New derivation, replacing
`buildMatrix`/`launchInfo`:

- **Axes from plain directory listings:** all agents from `coding-agents/*.yaml`
  stems; all scenarios from `scenarios/*/` dirs. No `checks.sh`
  `# coding-agents:` directive parsing, no `story.md` tier/draft frontmatter
  parsing — that harness-domain logic does **not** move into the dashboard.
- **Cells from `results/`:** each run dir contributes its `(scenario, agent)`
  cell and latest `verdict.json`. Cells with no run render as `not_run`.
- **Dropped:** the dimmed **n/a** categorization (directive/draft/tier-excluded
  cells). Those cells now render as ordinary `not_run`. This is an accepted minor
  UI fidelity loss; `launchInfo()`, the `c-na` rendering, and their test go away.

### Results-only (bare results dir) — the `knownAgents` bootstrap

`parseRunDirName` does longest-suffix agent matching against a `knownAgents`
list. With no `coding-agents/` present, that list would be empty and **every run
dir would fail to parse → empty grid** (the v1 "results-only" claim was broken;
`/par` caught it). Fix: when `coding-agents/` is absent, bootstrap `knownAgents`
from completed runs' `verdict.json` `coding_agent` field, then scan. Degradation
that remains and is acceptable: an in-flight run with no verdict yet can't be
agent-classified in bare-results mode (it appears once its verdict lands).

Read types stay local to the dashboard (it already narrows `verdict.json` via
`parseDashboardVerdict`). No shared-types package (YAGNI).

The SSE event-bus and ~1s scanner loop are kept unchanged.

### Run-dir name format note

`scan.ts`'s `parseRunDirName` was just updated by the OS-target work to parse an
**os segment** in run-dir names. The decoupled `parseRunDirName` must preserve
that current behavior (the dashboard moves the current code, not a stale copy).

## Target structure

```
evals/
  package.json            # root harness "quorum"; adds workspaces:["packages/dashboard"]
                          #   + script "dashboard" → run the package entrypoint
                          #   + check script extended to cover the package (see Tooling)
  src/                    # harness, unchanged except cli/index.ts loses `dashboard`
  scenarios/  coding-agents/  results/   # read by the dashboard (filesystem contract)
  packages/dashboard/
    package.json          # @quorum/dashboard, private; NO quorum dependency
    tsconfig.json         # own module graph
    biome.json            # own config (or root includes packages/dashboard/**)
    src/                  # scan, view, templates, event-bus, server, index(+CLI), contracts, static
    test/                 # moved + split dashboard tests
```

## What gets deleted / replaced / added

**Deleted:**
- `orchestrator.ts`; the `POST /launch` + `POST /stop` routes; `launchInfo()` and
  the `c-na` n/a-cell rendering; the launch controls in `static/app.js` (the
  `/launch` + `/stop` fetches) and `templates.ts` (`data-launch` attrs, the "▶"
  run buttons, `#runbar`); the `queued` cell state (dead without the orchestrator
  — `contracts.ts` field, the `view.ts` `queued` branch, `QUEUED_OPACITY`, the
  `.queued` CSS); the `quorum dashboard` subcommand + `startDashboard` import in
  `src/cli/index.ts`.
- Harness imports that rode with the above: `run-all/*`, `scheduler/*`,
  `agents/antigravity.ts`.

**Replaced (the read-path imports v1 missed):**
- `buildMatrix`/`knownAgentNames` (`run-all/matrix.ts`) → local filesystem grid
  derivation (dir listings + the verdict bootstrap above).
- `runnable`/`SkippedReason` (`contracts/batch.ts`) → removed with `launchInfo()`/n/a.
- `assertNever` (`invariant.ts`) → one-line local copy in the package.

**Added:**
- `packages/dashboard/src/index.ts` becomes a CLI entrypoint with arg parsing:
  `--results <dir>` (default `results/`), `--port N`, `--root <evals-repo>`
  (default cwd; used to find `scenarios/` + `coding-agents/`; absent ⇒
  results-only mode). `StartDashboardArgs` loses `invoke` and `jobs`.
- Root `package.json` script `"dashboard"` runs the entrypoint (script
  invocation, not a code import — keeps the harness free of any dashboard dep).

## Invocation

- `bun packages/dashboard/src/index.ts --results <dir> [--port N] [--root <evals-repo>]`
- `bun run dashboard` (root convenience script).
- `quorum dashboard` is **removed**. Note: the compiled `dist/quorum` binary
  (`bun build … cli/index.ts`) loses the subcommand — a documented breaking
  change for anyone invoking `dist/quorum dashboard`.

## Tooling (concrete — v1 handwaved this)

- **biome:** add `packages/dashboard/**` to root `biome.json` `files.includes`
  (or give the package its own `biome.json`), and move the `noConsole`-off
  override from `src/dashboard/**` to `packages/dashboard/**`.
- **tsc:** the package gets its own `tsconfig.json`; the root `tsconfig`
  (`include: ["src","test"]`) no longer needs the dashboard. Root `check` runs
  `tsc --noEmit` in both (root + `tsc -p packages/dashboard`).
- **tests:** root `bun test` does **not** auto-run workspace package tests. The
  root `check` script must invoke the package's tests explicitly (e.g.
  `bun --filter '*' test`, or `cd packages/dashboard && bun test`). Spell this
  out in `package.json`.
- `bun run quorum check` (scenario validation) is unaffected.

## Testing

- `test/dashboard-server.test.ts` is a **mixed** file: split it — delete the
  launch-path tests (`POST /launch`/`/stop`, the `invoke` stub, the `jobs` arg,
  the `InvokeChildArgs`/`ChildResult` harness imports); rewrite the read-path
  tests (`GET /`, `/events`, `/static/*`, SSE scanner) to drop the harness
  imports + removed args, then move them to the package.
- `scan`/`view`/`templates`/`event-bus` tests move to `packages/dashboard/test/`.
- Orchestrator/launch tests are deleted with the code.
- Add tests for the new grid derivation: (a) full grid from dir listings shows
  not_run cells; (b) results-only mode bootstraps agents from `verdict.json` and
  shows only cells with runs; (c) excluded cells render as `not_run` (no n/a).

## Docs

- Update `CLAUDE.md` and `AGENTS.md` (both document `bun run quorum dashboard`) →
  `bun run dashboard`.
- Fix the now-stale `run-all/matrix.ts` comment that references the dashboard's
  shared agent list.

## Migration — two steps, each green before the next

1. **Decouple in place** (no files move). In `src/dashboard/`: delete the
   orchestrator + launch routes + launch UI controls + `queued` dead code +
   `launchInfo`/n/a; replace `buildMatrix`/`knownAgentNames` with the local
   filesystem grid derivation + verdict bootstrap; inline `assertNever`; remove
   the `quorum dashboard` subcommand; add the CLI entrypoint/arg-parser. Split
   `dashboard-server.test.ts`. `bun run check` green — proves zero residual
   harness imports before anything moves (grep `src/dashboard` for `../` harness
   imports → none).
2. **Extract to a package.** Move `src/dashboard/` → `packages/dashboard/src/`
   and tests → `packages/dashboard/test/`; add the package `package.json` (no
   quorum dep) + `tsconfig.json` (+ biome); add `"workspaces"` to root; point the
   root `dashboard` script at the entrypoint; extend root `check`/biome/tsc to
   cover the package; update docs. Root check green.

Step 1 carries all the risk (behavior removal + grid rederivation + test split);
step 2 is then a no-logic relocation. After step 1 the enforced-boundary check is
"`src/dashboard/` imports nothing from `../` harness modules"; after step 2 it's
structural (the package has no quorum dependency).

## Self-review notes

- Revised after `/par`: corrected the false coupling audit (read-path
  `buildMatrix`/`contracts/batch`/`knownAgentNames`/`assertNever` survive the
  orchestrator cut), fixed the broken results-only mode (verdict `coding_agent`
  bootstrap), made the grid derivation honest (drop n/a, axes from dir listings),
  prescribed the concrete biome/tsc/test wiring, and added the
  `dashboard-server.test.ts` split + the launch-UI / `queued` / `jobs` /
  docs / `dist` cleanups.
- One judgment call, approved: drop the dimmed n/a categorization (excluded cells
  → `not_run`) to keep `checks.sh`/`story.md` parsing out of the dashboard.
- Enforcement is structural (package graph); lint-only was rejected.
- No shared-types package (YAGNI) — the on-disk JSON is the contract.
