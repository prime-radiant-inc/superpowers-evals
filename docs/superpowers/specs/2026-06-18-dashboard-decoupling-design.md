# Decouple the dashboard into a read-only workspace package (with the OS grid axis)

**Date:** 2026-06-18
**Status:** design approved; revised after adversarial (`/par`) review; incorporates
the OS-axis + rich-cells design (`2026-06-18-dashboard-os-axis-design.md`, folded in
here so the decoupled dashboard is built with it rather than re-touched after).
**Builds on:** `2026-06-18-os-target-dimension-design.md` (the `--os` dimension).

## Goal

Break the web dashboard out of the quorum harness into its own directory tree with
a **cleanly enforced, one-directional boundary**. The split is **harness ⇄
dashboard**: the harness runs evals and writes `results/`; the dashboard only
*visualizes* what's on disk. After this change the dashboard depends on **nothing**
from the harness — the filesystem is the only contract.

The same effort builds the new grid model the OS dimension needs: cells keyed by
`(scenario, agent, os)`, agent columns sub-split into per-OS sub-columns, and cells
that carry wall-clock time, estimated cost, and token count per run.

## Non-goals

- Not decomposing the harness into packages (it stays one root package).
- Not changing how evals run, capture, price, or grade; not changing how the runner
  writes `verdict.json` (every field consumed here is already written today).
- Not building a remote/hosted dashboard, auth, or a new UI framework. Same
  Bun.serve server, same SSE live-update model — relocated, read-only, launch UI
  removed.
- Not preserving in-UI launch/stop (removed; OS runs launch via
  `quorum run --os` / `run-all --os`).
- Not preserving the dimmed **n/a** cell categorization (excluded cells → `not_run`).
- No OS **filter** UI (OS is an axis, per decision); no metrics beyond
  time/cost/tokens.

## Decision

**The dashboard becomes an isolated Bun-workspaces package; the harness stays at the
repo root.** The dashboard package declares zero dependency on the harness, so it
structurally cannot import harness code — the boundary is enforced by the package
graph, not by lint.

### Rejected alternatives

- **Full monorepo (`packages/harness` + `packages/dashboard`).** Over-scoped —
  churns the whole repo to separate a leaf. Reachable later if a second harness-side
  package appears.
- **Dir move + lint-enforced boundary.** Enforcement is bypassable lint, not
  structural; the ask was an *enforced* boundary.

## The coupling, corrected (`/par` caught this — v1 was wrong)

Deleting `orchestrator.ts` removes the launch coupling (`run-all`
`invokeChild`/`stopBatch`/`batch-index`, `scheduler` `runSchedule`/`RealClock`,
`agents/antigravity.ts`), but several **read-path** harness imports survive and must
also be removed/replaced:

- `server.ts` → `buildMatrix` (`run-all/matrix.ts`), `runnable`/`SkippedReason`
  (`contracts/batch.ts`), used by `launchInfo()` from the `GET /` route.
- `index.ts` → `knownAgentNames` (`run-all/matrix.ts`).
- `templates.ts` → `assertNever` (`invariant.ts`).

"Net harness imports: none" is the *target*, reached only after replacing all of the
above — not a free consequence of deleting the orchestrator. Reverse deps remain
one: only `src/cli/index.ts` imports `startDashboard`.

## Grid model

### Cell identity is 3-part: `(scenario, agent, os)`

Today a cell is keyed `(scenario, agent)`. It becomes `(scenario, agent, os)`.

- `cellKey(scenario, agent, os)` → `${scenario}\t${agent}\t${os}` (tab-joined; tab
  absent from all three tokens).
- `cellId(scenario, agent, os)` → `cell-${scenario}-${agent}-${os}` (DOM id +
  SSE `sse-swap` event name).
- The local `Cell`/`CellView` read-types gain `readonly os: string`.

This also fixes a latent **bucketing bug**: the current scan keys the window by
`(scenario, agent)` only, so a windows run and a linux run of the same scenario/agent
collapse into one cell's window and interleave. Keying by `(scenario, agent, os)`
separates them.

### Where the grid comes from (replacing `buildMatrix`/`launchInfo`)

- **Axes from plain directory listings (full grid):** scenarios from `scenarios/*/`;
  agents from `coding-agents/*.yaml` stems; the OS sub-columns under an agent are that
  agent's `os_support` list, read from `coding-agents/<agent>.yaml` (a local YAML read
  — no harness import). An agent with no `os_support` defaults to `[linux]`. Empty
  `not_run` cells appear for every `(scenario, agent, os)` in
  `scenarios × agents × agent.os_support`. **No** `checks.sh` `# coding-agents:`
  directive parsing and **no** `story.md` tier/draft frontmatter parsing move into the
  dashboard — directive/draft/tier-excluded cells simply render as `not_run` (the
  dropped n/a categorization).
- **Cells from `results/`:** each run dir contributes its `(scenario, agent, os)` cell
  and latest `verdict.json`. The OS token is parsed from the run-dir name
  `<scenario>-<agent>-<os>-<stamp>-<nonce>` — `scan.ts`'s `parseRunDirName` already
  extracts the OS segment (added by the OS-target work); the decoupled parser must
  preserve that current behavior (it moves the current code, not a stale copy).

### Results-only (bare results dir) — the `knownAgents` bootstrap

`parseRunDirName` does longest-suffix agent matching against a `knownAgents` list.
With no `coding-agents/` present, that list is empty and **every run dir fails to
parse → empty grid** (the broken v1 "results-only" claim `/par` caught). Fix: when
`coding-agents/` is absent, bootstrap `knownAgents` from completed runs'
`verdict.json` `coding_agent` field, then scan. In results-only mode the OS
sub-columns are exactly those observed in run-dir names. Acceptable residual
degradation: an in-flight run with no verdict yet can't be agent-classified in
bare-results mode (it appears once its verdict lands).

Read types stay local to the dashboard (it already narrows `verdict.json` via
`parseDashboardVerdict`). No shared-types package (YAGNI). SSE event-bus + ~1s
scanner loop unchanged; only the cell ids/keys become 3-part so SSE swaps address the
right `(scenario, agent, os)` `<td>`.

## Rich cells: time, cost, tokens

Each run shows three metrics, all already in the run's `verdict.json` `economics`
block (`RunEconomics` from `src/economics.ts`). The dashboard widens its narrow read
schema to read:

- **Cost:** `economics.total_est_cost_usd` (already read).
- **Tokens:** `economics.coding_agent.tokens.total` (the subject's total).
- **Time:** `economics.coding_agent.duration_ms`; fall back to
  `finished_at − started_at` when null (legacy/partial captures).

`RunRecord` gains `readonly duration_ms: number | null` and
`readonly total_tokens: number | null` next to `cost_usd`. Every read is
`.catch`-guarded per the defensive-narrowing rule: a missing/wrong-typed field
degrades that one metric to "—"/"unknown", never sinks the verdict parse. Unknowns
render as "—", never `$0` / `0 tok` / `0s`.

**Display:** keep the verdict ribbon; add a compact metric line on the cell face for
the newest run (e.g. `2m41s · $0.77 · 48.2k tok`). The hover card (the existing
oldest..newest run window, cap 5) gains the three metrics beside each run's verdict +
timestamp — a true multi-run time/cost/tokens history. The window cap is a single
constant; raising it is the implementer's call if grid performance holds.

## Layout

- Two-tier column header: a top row of agent names, each spanning its OS sub-columns;
  a second row of OS labels under each agent. Body: one `<tr>` per scenario, one
  `<td>` per `(agent, os)` sub-column, rendered by the existing `cellHtml` keyed on
  the 3-part `cell_id`. `headerTally` iterates `scenario × agent × os` over the same
  cell set (counts unchanged in meaning).
- **Hide the OS sub-label row when the displayed OS set is exactly `{linux}`** (so
  today's common linux-only grid looks identical); show it the moment any agent
  contributes a second OS. (This adopts the OS-axis spec's open-question
  recommendation — adjustable at review.)

## Target structure

```
evals/
  package.json            # root harness "quorum"; workspaces:["packages/dashboard"];
                          #   "dashboard" script; check extended to cover the package
  src/                    # harness, unchanged except cli/index.ts loses `dashboard`
  scenarios/  coding-agents/  results/   # the filesystem contract
  packages/dashboard/
    package.json          # @quorum/dashboard, private; NO quorum dependency
    tsconfig.json  biome.json
    src/   test/
```

## What gets deleted / replaced / added

**Deleted:** `orchestrator.ts`; `POST /launch`+`/stop`; `launchInfo()` + `c-na`
n/a rendering; launch controls in `static/app.js` (`/launch`,`/stop` fetches) and
`templates.ts` (`data-launch`, "▶" buttons, `#runbar`); the `queued` cell state
(dead without the orchestrator — `contracts.ts` field, `view.ts` branch,
`QUEUED_OPACITY`, `.queued` CSS); the `quorum dashboard` subcommand +
`startDashboard` import in `src/cli/index.ts`; the harness imports `run-all/*`,
`scheduler/*`, `agents/antigravity.ts`.

**Replaced:** `buildMatrix`/`knownAgentNames` → local filesystem grid (dir listings
+ `os_support` reads + verdict bootstrap); `runnable`/`SkippedReason` → removed with
n/a; `assertNever` → one-line local copy.

**Added:** `packages/dashboard/src/index.ts` as a CLI entrypoint with arg parsing —
`--results <dir>` (default `results/`), `--port N`, `--root <evals-repo>` (default
cwd; finds `scenarios/`+`coding-agents/`; absent ⇒ results-only). `StartDashboardArgs`
loses `invoke` and `jobs`. Root `package.json` `"dashboard"` script runs the
entrypoint (script invocation, not a code import).

## Invocation

- `bun packages/dashboard/src/index.ts --results <dir> [--port N] [--root <evals-repo>]`
- `bun run dashboard` (root convenience).
- `quorum dashboard` is **removed**; the compiled `dist/quorum` binary loses the
  subcommand (documented breaking change).

## Tooling (concrete)

- **biome:** add `packages/dashboard/**` to root `biome.json` `files.includes` (or a
  package-local `biome.json`); move the `noConsole`-off override from `src/dashboard/**`
  to `packages/dashboard/**`.
- **tsc:** the package gets its own `tsconfig.json`; root `check` runs `tsc --noEmit`
  in both.
- **tests:** root `bun test` does **not** auto-run workspace package tests; the root
  `check` script must invoke the package's tests explicitly (`bun --filter '*' test`
  or `cd packages/dashboard && bun test`). Spell it out in `package.json`.
- `bun run quorum check` unaffected.

## Read-types / contracts (all local to the package)

`Cell`/`CellView` gain `os: string`; `RunRecord` gains `duration_ms` and
`total_tokens`; the local `verdict.json` narrow schema widens to read
`economics.coding_agent.{duration_ms,tokens.total}` and `economics.total_est_cost_usd`.
None of this lives in a shared types package — the on-disk JSON is the contract.

## Testing (for the dashboard package)

- **Decoupling:** after step 1, `src/dashboard/` imports nothing from `../` harness
  modules; after step 2 it's structural (no quorum dep).
- **`dashboard-server.test.ts` is mixed** — split: delete launch-path tests (the
  `invoke` stub, `jobs`, `InvokeChildArgs`/`ChildResult` imports); rewrite read-path
  tests (`GET /`, `/events`, `/static/*`, SSE) to drop harness imports + removed args;
  then move. `scan`/`view`/`templates`/`event-bus` tests move too.
- **OS axis:** bucketing — two run dirs for the same `(scenario, agent)` with
  different OS land in distinct cells; same-OS share a window. Full-grid — an agent
  with `os_support:[linux,windows]` yields two sub-columns, a linux-only agent one,
  `not_run` for unran triples. Results-only — OS sub-columns are exactly those in
  run-dir names. `cellId`/`sse-swap` are 3-part and match.
- **Metrics:** a verdict with `duration_ms`+`tokens.total`+`total_est_cost_usd`
  renders all three; missing each renders "—" (no `$0`/`0`).
- **Grid derivation:** results-only bootstraps agents from `verdict.json`; excluded
  cells render `not_run` (no n/a).

## Docs

Update `CLAUDE.md` + `AGENTS.md` (`bun run quorum dashboard` → `bun run dashboard`);
fix the stale `run-all/matrix.ts` comment referencing the dashboard's shared agent
list.

## Migration — two steps, each green before the next

1. **Decouple + rebuild the grid model, in place** (no files move). In
   `src/dashboard/`: delete orchestrator + launch routes + launch UI + `queued` +
   `launchInfo`/n/a; replace `buildMatrix`/`knownAgentNames` with the local
   filesystem grid (3-part `(scenario, agent, os)` cells, OS sub-columns from
   `os_support`, verdict bootstrap); add the rich-cell metrics (time/cost/tokens) +
   the two-tier OS layout; inline `assertNever`; remove the `quorum dashboard`
   subcommand; add the CLI entrypoint/arg-parser; split `dashboard-server.test.ts`.
   `bun run check` green; grep `src/dashboard` for `../` harness imports → none.
2. **Extract to a package.** Move `src/dashboard/` → `packages/dashboard/src/` +
   tests; add the package `package.json` (no quorum dep) + `tsconfig`/biome; add
   `"workspaces"`; point the root `dashboard` script at the entrypoint; extend root
   `check`/biome/tsc to cover the package; update docs. Root check green.

Step 1 carries all the risk (behavior removal + grid rederivation + OS axis + rich
cells + test split); step 2 is a no-logic relocation.

## Self-review notes

- Incorporates the OS-axis + rich-cells design into the decoupling effort: 3-part
  `(scenario, agent, os)` cells, `os_support`-driven sub-columns, time/cost/tokens
  from `verdict.json`, multi-run cells, two-tier header (hide OS row when `{linux}`),
  and the bucketing-bug fix — all via filesystem-local reads, consistent with the
  decoupling invariants.
- `/par` fixes retained: corrected coupling audit (read-path imports survive the
  orchestrator cut), results-only verdict-bootstrap, dropped n/a, concrete tooling,
  the `dashboard-server.test.ts` split, launch-UI/`queued`/`jobs`/docs/`dist`
  cleanups.
- Enforcement is structural (package graph). No shared-types package (YAGNI).
- One open item adopted-with-default: hide the OS sub-label row when the displayed OS
  set is exactly `{linux}` (adjustable at review).
