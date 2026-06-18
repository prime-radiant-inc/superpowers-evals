# Decouple the dashboard into a read-only viewer (OS axis · grid manifest · rich cells)

**Date:** 2026-06-18
**Status:** design approved; revised after two `/par` rounds (code + UX). Incorporates
the OS-axis design (`2026-06-18-dashboard-os-axis-design.md`) and the decisions Jesse
made on 2026-06-18 (harness-emitted grid manifest; two-line cells; 5-state cells).
**Builds on:** `2026-06-18-os-target-dimension-design.md` (the `--os` dimension).

## Goal

Break the dashboard out of the quorum harness into its own directory tree with a
**cleanly enforced, one-directional boundary** (harness ⇄ dashboard). The harness
runs evals + writes `results/` **and now emits a grid manifest**; the dashboard is a
read-only viewer whose only contract is the filesystem. The same effort builds the
OS grid axis and richer cells.

## Non-goals

- Not decomposing the harness into packages (it stays one root package).
- Not changing how evals run/capture/price/grade; not changing `verdict.json` (every
  field consumed already exists).
- No in-UI launch/stop (removed; runs launch via `quorum run --os` / `run-all --os`).
- No OS filter UI (OS is an axis); no metrics beyond time/cost/tokens.

## Decision

**The dashboard becomes an isolated Bun-workspaces package; the harness stays at the
repo root.** The package declares zero dependency on the harness — the boundary is
structural (package graph), not lint. Rejected: full monorepo (over-scoped, churns
the whole repo to separate a leaf); dir-move + lint rule (bypassable).

## Two filesystem contracts the dashboard reads

1. **`results/`** — per-run `verdict.json` (the runner already writes it).
2. **`grid-manifest.json`** — NEW, harness-emitted. The authoritative
   `scenario × agent × os` eligibility matrix, so the dashboard never parses
   `checks.sh`/`story.md`/`coding-agents/*.yaml` itself.

Everything else (no harness imports, local read-types, SSE + ~1s rescan) is
unchanged.

### Harness side (new, small): emit the grid manifest

`buildMatrix` already computes per-`(scenario, agent)` `skippedReason ∈
{directive, draft, tier, null}` + tier. Extend it across the `os` axis (each agent's
`os_support`, default `[linux]`) and serialize to `grid-manifest.json`:

```
{ generated_at, scenarios:[…], cells:[ { scenario, agent, os,
    eligible:boolean, skipped_reason:"directive"|"draft"|"tier"|null } … ] }
```

Written by `quorum run-all` (it builds the matrix already) and by a standalone
`quorum grid-manifest` command, to a configurable path (default `<root>/grid-manifest.json`).
This is harness code (stays in `src/`); the harness owns all eligibility logic and
the dashboard just consumes the emitted data.

## The coupling, corrected (`/par` code review caught this)

Deleting `orchestrator.ts` removes the launch coupling (`run-all`
`invokeChild`/`stopBatch`, `scheduler`, `agents/antigravity.ts`), but read-path
imports survive and must also go: `server.ts` → `buildMatrix` + `runnable`/
`SkippedReason`; `index.ts` → `knownAgentNames`; `templates.ts` → `assertNever`.
"Net harness imports: none" is the target, reached only after replacing all of
these (the grid manifest replaces the `buildMatrix`/`knownAgentNames` need;
`assertNever` is inlined). Reverse deps remain one: `cli/index.ts` →
`startDashboard` (removed with `quorum dashboard`).

## Grid model

### Cell identity is 3-part `(scenario, agent, os)`

- `cellKey` = `${scenario}\t${agent}\t${os}`; `cellId`/`sse-swap` =
  `cell-${scenario}-${agent}-${os}`. `Cell`/`CellView` gain `readonly os: string`.
- Fixes a real **bucketing bug**: today the window is keyed `(scenario, agent)`, so
  windows + linux runs of the same scenario/agent collapse into one cell and
  interleave. 3-part keying separates them.

### Where the grid comes from

- **Full grid:** the columns/cells come from `grid-manifest.json` — scenarios,
  agents, each agent's OS sub-columns, and per-cell eligibility/reason. The dashboard
  does **no** directive/frontmatter/`os_support` parsing of its own.
- **Cells overlaid from `results/`:** each run dir contributes its
  `(scenario, agent, os)` latest verdict + run window. The OS token is parsed from
  the run-dir name `<scenario>-<agent>-<os>-<stamp>-<nonce>` (the OS-target work
  already added this to `scan.ts`'s parser; preserve it).
- **Results-only (no manifest):** derive observed cells from `results/` alone;
  bootstrap `knownAgents` from completed runs' `verdict.json` `coding_agent` field
  (without it the agent-suffix match yields an empty grid — `/par` caught this).
  OS sub-columns are whatever the run-dir names show. No eligibility info in this
  mode, so no `ineligible` cells.

### 5-state cells (Jesse: distinguish "ran but failed grading" from "didn't complete")

Every cell renders as exactly one of:

| State | Source | Meaning |
|---|---|---|
| **pass** | `verdict.final == 'pass'` | completed + graded pass |
| **failed grading** | `verdict.final == 'fail'` | agent ran to completion, grading failed |
| **didn't complete** | `verdict.final == 'indeterminate'` (`error.stage` shown) | run errored / capture empty / never finished |
| **not_run** | eligible in manifest, no run dir | hasn't run yet |
| **ineligible** | manifest `eligible:false` (reason on hover) | can't run here (directive/draft/tier) |

`failed grading` and `didn't complete` get **distinct** visual treatments (today both
land near "fail/indeterminate" but the distinction must be legible — it's the
difference between a real AC failure and an infra/capture problem). `ineligible`
restores the dimmed "n/a"-style cell (with the reason in its tooltip), now sourced
from the manifest rather than dashboard-side parsing. OS-unsupported `(agent, os)`
pairs simply have no sub-column (not a cell state).

## Cells: two-line face + rich metrics

All metrics come from each run's `verdict.json` `economics` block, **agent-scoped for
the cell face** so the two values share one scope (`/par` UX caught a cost/token
scope mismatch):

- **Time (headline, line 1):** `economics.coding_agent.duration_ms`; fall back to
  `finished_at − started_at` when null.
- **Cost (line 2):** `economics.coding_agent.est_cost_usd` (agent-scoped).
- **Tokens:** `economics.coding_agent.tokens.total` — **hover/click-through only**
  (kept off the dense face).

`RunRecord` gains `duration_ms`, `total_tokens` (next to `cost_usd`). Every read is
`.catch`-guarded: a missing/wrong field degrades that one metric to "—", never sinks
the parse. Unknowns render "—", never `$0`/`0 tok`/`0s`.

**Hover card (multi-run):** the existing oldest..newest window (cap 5) — each run row
gains time/cost/tokens beside its verdict + timestamp, with run-total cost shown
there too, labeled, so the agent-vs-run scope is explicit. Cell face shows the
**newest** run; the card carries the history.

## Layout (folds in the UX `/par` fixes)

- **Always render the two-tier header** (agent names spanning OS sub-columns; OS-label
  row beneath). When the displayed OS set is exactly `{linux}`, **collapse the OS row
  via CSS (`visibility`/zero-height), not by removing it from the DOM** — so column
  indices stay stable and SSE `<td>` swaps + the column-highlight don't break when an
  agent gains a second OS mid-session.
- **Sticky-left scenario-label column** (`position:sticky; left:0`) — the OS axis
  widens the grid past laptop width; row labels must stay visible on horizontal
  scroll. (Header is already sticky-top.)
- Each sub-column `<th>` carries `data-agent` + `data-os`; the column-highlight
  (`washColumn`) keys on those attributes, not positional index (which breaks under
  the multi-OS header).
- Subtle agent-group separation (left border/shade at each agent boundary) so a body
  `<td>`'s `(agent, os)` ownership is scannable.
- **Tally** counts OS sub-columns, not "agents" (e.g. "N scenarios · K columns"), and
  reports `ineligible` separately from `not_run` so excluded cells don't inflate the
  not-run figure.
- **Mode indicator**: a header banner shows full-grid vs results-only ("coverage view
  — manifest not found") so a sparse results-only grid isn't mistaken for full
  coverage.
- Card-row grid template widened for the added time/tokens columns.
- Minors: a brief flash on SSE cell swap (HTMX `.htmx-added`); an empty/zero-state
  message when `results/` is empty; verdict labels get a shape/glyph (✓/✗/~) so the
  pass/fail/indeterminate triad isn't color-only (colorblind safety).

## Target structure / invocation / tooling

```
evals/  package.json (root harness; workspaces:["packages/dashboard"]; "dashboard" script)
        src/ (harness; gains the grid-manifest emitter; cli loses `dashboard`)
        grid-manifest.json  results/  scenarios/  coding-agents/
        packages/dashboard/ { package.json(@quorum/dashboard, no quorum dep), tsconfig, biome, src/, test/ }
```

- Run: `bun packages/dashboard/src/index.ts --results <dir> [--port N] [--manifest <path>] [--root <repo>]`;
  `bun run dashboard` (root script). `quorum dashboard` removed (the compiled
  `dist/quorum` loses the subcommand — documented breaking change).
- **Tooling (concrete):** add `packages/dashboard/**` to biome (move the
  `noConsole`-off override there); the package gets its own `tsconfig`; root `check`
  runs biome + `tsc --noEmit` + tests for **both** root and package (root `bun test`
  does not auto-run workspace tests — invoke them explicitly). `quorum check`
  unaffected.

## Testing

- **Decoupling:** post-step-1 `src/dashboard/` imports nothing from `../` harness;
  post-step-2 structural (no quorum dep).
- **`dashboard-server.test.ts` is mixed** — delete launch tests (`invoke`, `jobs`,
  harness-type imports), rewrite read-path tests to drop them, then move with the
  rest.
- **Manifest + states:** manifest-driven full grid shows ineligible cells with
  reasons; results-only (no manifest) shows observed cells + bootstrapped agents, no
  ineligible; the 5 states each render distinctly; `fail` vs `indeterminate` are
  visually different and `indeterminate` surfaces `error.stage`.
- **OS axis:** bucketing (different-OS runs → distinct cells); two-tier header column
  stability when the OS set changes; 3-part `cellId`/`sse-swap` match.
- **Metrics:** all three present render; each missing renders "—"; cell-face cost +
  tokens are agent-scoped.
- **Harness:** `quorum grid-manifest` emits the matrix with correct
  eligibility/reasons; `run-all` writes it.

## Docs

Update `CLAUDE.md` + `AGENTS.md` (`quorum dashboard` → `bun run dashboard`); document
`grid-manifest.json` + `quorum grid-manifest`; fix the stale `run-all/matrix.ts`
comment.

## Migration — phased, each green before the next

0. **Harness: grid manifest.** Extend `buildMatrix` over the OS axis; add
   `quorum grid-manifest` + the `run-all` write. `bun run check` green. (Independent
   of the dashboard move.)
1. **Decouple + rebuild the dashboard, in place.** Delete orchestrator + launch
   routes + launch UI + `queued` dead code; replace the grid derivation with manifest
   + `results/` reads (3-part cells, 5 states, two-line face, OS sub-columns, sticky
   column, two-tier header, mode banner, results-only bootstrap); inline
   `assertNever`; remove `quorum dashboard`; add the CLI entrypoint; split
   `dashboard-server.test.ts`. `bun run check` green; grep `src/dashboard` for `../`
   harness imports → none.
2. **Extract to a package.** Move to `packages/dashboard/`; add package
   `package.json`(no quorum dep)/`tsconfig`/biome + `workspaces` + the root script;
   extend root `check`; update docs. Root check green.

Phase 0 is small + independent; Phase 1 carries the dashboard risk; Phase 2 is a
no-logic relocation.

## Self-review notes

- Jesse's two decisions folded in: (1) harness **emits a grid manifest** the
  dashboard consumes (resolves excluded-vs-not_run without the dashboard parsing
  `checks.sh`/`story.md`, and replaces dir-listing axis derivation); (2) **two-line
  cell face** (time headline · cost; tokens on hover) + a **5-state** taxonomy that
  distinguishes ran-to-completion-but-failed-grading (`fail`) from didn't-complete
  (`indeterminate`).
- Both `/par` rounds folded in: corrected coupling audit + results-only bootstrap +
  tooling + test split (code review); always-two-tier header, sticky-left column,
  agent-scoped face metrics, mode indicator, tally/excluded counts, washColumn
  attribute keying, card-grid, colorblind glyphs (UX review).
- Enforcement structural; no shared-types package (the on-disk JSON + manifest are
  the contracts).
