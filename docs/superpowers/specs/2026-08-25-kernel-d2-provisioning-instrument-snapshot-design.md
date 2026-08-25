# Kernel Deliverable 2 — Provisioning + Instrument Snapshot: Design

**Date:** 2026-08-25
**Status:** proposed
**Parent spec:** `docs/superpowers/specs/2026-08-17-quorum-campaign-platform-design.md`
  (the campaign platform design; "the parent" below)
**Prerequisite:** Kernel D1 contracts (merged to main @ `41b9e2b`; PRI-2944 done;
  spec `docs/superpowers/specs/2026-08-24-kernel-d1-contracts-design.md`, revision 2)
**Program ticket:** PRI-2874 umbrella (kernel build, order-of-operations item 3,
  deliverable 2 of 4)
**Approach record:** operator design session 2026-08-25 with an independent
  advisor seat (qwen3.8-max); approach A′ adopted (Decisions D-1…D-5 record what
  was kept, cut, and why).

## Purpose and place in the program

The parent's kernel build names four deliverables in fixed order: **contracts →
provisioning + instrument snapshot → dispatcher + journal + locks → profiles +
report engine**. D1 shipped the contracts. This document is the
implementation-level spec of deliverable 2: the two modules the parent's seam
map assigns to D2 (`provisioning`, `instrument-snapshot`) plus the runner
threading primitive that makes per-child superpowers roots real before D3's
dispatcher exists.

The parent's two headline questions (PR-vs-base, superpowers-vs-stock) require
what no adapter can do today: every adapter reads host-global `SUPERPOWERS_ROOT`
and hard-fails without it, so two arms of one block cannot run from two
different superpowers checkouts on one host. The instrument snapshot closes the
second hole: registration pinning names is not pinning the instrument — the
runner reads `story.md`, `checks.sh`, and the prelude from mutable paths at run
time, so a mid-campaign edit can yield old pre-checks and new post-checks under
a report claiming the registered SHA.

D2 supplies libraries and the primitive; **D3 owns all campaign-directory
layout, registration integration, and dispatcher wiring.** Where this spec
deviates from a first-reading of the parent text it says so (Decisions).

## Locked inputs (decisions already made with the operator)

1. **Wire the runner primitive now.** The per-run superpowers root threads
   through the existing runner in D2; D2 is not a library-only deliverable
   waiting for D3's dispatcher.
2. **Acceptance bar:** hermetic gates (fake `CommandRunner` seam) plus **one
   live claude smoke** (root mode and `none` mode); the full per-adapter live
   sweep rides the qualification campaign (parent: "Qualification before the
   first gate").
3. **Approach A′** (advisor-amended): keep the two materializer modules and the
   threading primitive; cut the ad-hoc UX layer (in-runner ref resolution,
   shared worktree cache, per-YAML capability flags, `repoRoot()` override
   seam) as unrequested complexity — see Decisions.

## Code reality this design builds on (verified 2026-08-25)

- All nine adapters read `SUPERPOWERS_ROOT` from the ambient env
  (`getEnv('SUPERPOWERS_ROOT')`) and hard-fail on absence; the setup projection
  (`SETUP_ENV_ALLOWLIST`, `src/setup-step.ts`), the checks projection
  (`CHECK_ENV_ALLOWLIST`, `src/checks/index.ts:27-39`), the runner-built
  `$SUPERPOWERS_ROOT` substitution map (`populateContextDir`,
  `src/runner/context.ts`), and the provenance probe all read the same ambient
  channel.
- `RunScenarioArgs` (`src/runner/index.ts:380-424`) is the entry shared by the
  public `quorum run` command and `run-all`'s internal child entry — the
  parent's "one execution primitive." It already carries
  `credentialsOrigin: 'external-campaign' | 'canonical-snapshot'` in
  anticipation of campaign snapshots.
- `RunHome` (`src/agents/index.ts:34-45`) is the established per-run
  provisioning context channel (configDir, workdir, skeletonRoot, scenarioDir);
  adapters consume it in `provision(home, runner, credential?)`.
- `verdict.json .provenance.superpowers_rev` already exists
  (`src/contracts/verdict.ts:81-91`, PRI-2494: nullable, best-effort), so D2's
  black-box acceptance target needs no verdict schema change.
  `QUORUM_SUPERPOWERS_REV` remains the container-path override.
- `ArmSchema.superpowers` (`src/contracts/campaign/arm.ts:6-11`) admits any
  non-empty ref or `"none"` and **pins tag-vs-SHA disambiguation as D3
  registration's job** (`resolveSuperpowersRef`).
- `GAUNTLET_ROOT` is deliberately absent from the gauntlet child env
  (`src/runner/gauntlet-env.ts:61-63`); the gauntlet CLI is resolved host-side
  (`PATH` via `bun link`, or `GAUNTLET_ROOT` in the container wrapper).

## Scope

All TDD, repo gates (`bun run check`, `bun run quorum check`) green per commit:

1. **`provisioning` module** (`src/campaign/provisioning.ts`): the superpowers
   worktree materializer and the `none`-mode semantics contract; plus the
   code-level adapter capability registry (homed beside the adapter factory map
   in `src/agents/index.ts` — Decision D-4).
2. **`instrument-snapshot` module** (`src/campaign/instrument-snapshot.ts`):
   the evals+gauntlet campaign-local materializer and the `verifySnapshot`
   drift guard.
3. **Runner threading:** `RunScenarioArgs.superpowers` (discriminated union),
   a `RunHome` carrier field, explicit-wins consumption at every ambient read
   site (adapters, setup projection, checks projection, context substitution,
   provenance probe).
4. **CLI projection:** `quorum run --superpowers-root <path>` and
   `--no-superpowers` (mutually exclusive; resolved paths only, no ref
   resolution) — the "child-arg construction" surface D3's spawned campaign
   children will use.
5. **Acceptance evidence:** the hermetic matrix of section "Testing", plus one
   live claude smoke in both modes asserting the provenance readback.

## Non-goals

- **No ref→SHA resolution in the runner.** Pinned to D3 registration by
  `arm.ts`. A second resolver duplicates the seam; a campaign child receiving a
  ref would re-materialize inside the child that admission was supposed to
  gate. The runner receives a resolved root path or `none`, never a ref.
- **No shared/ad-hoc worktree cache.** The parent pins worktree placement under
  the campaign directory; the materializer takes a caller-supplied `destParent`
  (D3 passes the campaign dir; tests and the smoke pass a tmpdir). A cache can
  layer on later without touching D3.
- **No `repoRoot()` override seam.** D3 spawns children with cwd inside the
  snapshot; `repoRoot()` (import.meta.url-based, `src/paths.ts:12-15`) resolves
  to the snapshot for free, and `bun run` picks up the snapshot's lockfile.
- **No campaign-dir layout, registration integration, or dispatcher wiring**
  (D3). D2's modules are libraries plus the runner primitive.
- **No per-YAML capability flags.** Capability is a fact about adapter code; a
  YAML claim can drift from implementation, and a false "supported" claim is
  the "up and lying" failure class. The registry is code-level, default-deny.
- **`run-all`, the appliance, the dashboard, the container path, and Windows
  provisioning are untouched** (parent Coexistence; `os: windows` stays a
  registration error). Threading leaves the `undefined` (legacy) path
  byte-for-byte behavior-identical.
- **No verdict schema change.** The existing nullable `provenance` block
  carries the acceptance evidence.

## Decision D-1: materialization is a library; threading is the runner primitive

These are separate concerns and D2 keeps them separate. The materializers know
nothing about runs; the runner threading knows nothing about materialization —
it receives an already-materialized root (or `none`). The parent's
"the dispatcher materializes one immutable worktree per distinct SHA under the
campaign directory" makes D3 the materializer's caller; the operator-locked
"wire the runner primitive now" covers threading only. (Advisor review:
approach A conflated the two via the CLI flag plus cache; A′ separates them and
matches both texts.)

## Decision D-2: the runner receives resolved roots, never refs

Pinned by `arm.ts` (resolution is D3's `resolveSuperpowersRef`) and reinforced
by the admission ordering argument above. The CLI projection therefore takes
paths, not refs.

## Decision D-3: a discriminated union, explicit-wins with legacy fallback

```ts
export type SuperpowersSpec =
  | { mode: 'none' }
  | { mode: 'root'; root: string };
// RunScenarioArgs.superpowers?: SuperpowersSpec | undefined
```

The three states are load-bearing and must never be conflated:

- `undefined` — **legacy**: today's ambient host-env behavior, unchanged
  (Coexistence: `run-all`, ad-hoc runs, and the container path ride this).
- `{ mode: 'none' }` — **explicit suppression**: skip all superpowers staging;
  `SUPERPOWERS_ROOT` is stripped from the setup/checks projections; the
  provenance rev reads null. Absence-of-env is *not* the none signal (that
  reinterpretation would turn a forgotten env var into a silent stock-agent
  run — the silent-mislabel class behind the $650 discredited gate and the
  $850 re-gate).
- `{ mode: 'root' }` — **explicit root**: every read site uses it.

Adapter consumption form: `home.superpowers?.mode === 'root' ?
home.superpowers.root : home.superpowers?.mode === 'none' ? <skip staging> :
getEnv('SUPERPOWERS_ROOT')` — explicit wins, legacy fallback preserved. All
nine adapters are touched once, now (parent: "sized honestly — it touches all 9
adapters").

## Decision D-4: the capability registry is code-level and default-deny

Per adapter family, a declared `{ ref: boolean; none: boolean }` capability set
living beside the factory map in `src/agents/index.ts` (the registry D1 pinned
as "D1 pins the registry seam, D2 fills it"). Absence means unsupported. D2
flags **claude only** — it is the smoke-tested adapter; the other eight flip as
qualification proves their black-box provenance readback. D3 registration reads
this registry to reject `none`/ref arms for unproven agents (parent:
"Registration rejects `none`/ref arms for agents whose adapter has not
implemented the mode").

## Decision D-5: no `repoRoot()` seam; snapshot re-entry is cwd-based

`repoRoot()` derives from the module's own URL, so a child process spawned with
cwd inside the snapshot resolves every scenario/prelude/config path against the
snapshot for free, and `bun run` walks up to the snapshot's `package.json` /
frozen lockfile. D2 builds and verifies the snapshot; D3 owns cwd-at-spawn.
This deletes the apparent "runner must learn to run from an arbitrary root"
complexity.

## Contracts

### `provisioning` module

```ts
// src/campaign/provisioning.ts
export interface MaterializeSuperpowersArgs {
  /** Local superpowers checkout to source the worktree from. */
  readonly sourceCheckout: string;
  /** Resolved full SHA (refs never reach here — Decision D-2). */
  readonly sha: string;
  /** Parent dir; D3 passes the campaign dir, tests/smoke pass a tmpdir. */
  readonly destParent: string;
  readonly runner: CommandRunner;
}
/** Returns the worktree root path: <destParent>/superpowers-<sha>. */
export function materializeSuperpowersWorktree(
  args: MaterializeSuperpowersArgs,
): string;

export class ProvisioningError extends Error {}
```

Semantics:

- `git -C <sourceCheckout> worktree add --detach <destParent>/superpowers-<sha> <sha>`,
  through the `CommandRunner` seam (hermetic-testable).
- **Idempotent per SHA within `destParent`** — this *is* the parent's "one
  immutable worktree per distinct SHA." A pre-existing path is reused only if
  `HEAD == sha` and `git status --porcelain` is empty; anything else throws
  `ProvisioningError`. A drifted tree is never silently reused.
- The worktree is immutable post-materialization: nothing in quorum writes to
  it; drift detection on reuse (and D3's per-admission `verifySnapshot`) is the
  guard.
- The `none`-mode semantics contract is exported from here and consumed by the
  threading layer: zero skill/plugin/hook staging, `SUPERPOWERS_ROOT` absent
  from child env projections, provenance rev null.

### Capability registry

```ts
// src/agents/index.ts, beside CUSTOM_AGENTS
export interface SuperpowersCapability {
  readonly ref: boolean;
  readonly none: boolean;
}
export function superpowersCapability(agentName: string): SuperpowersCapability;
// Default-deny: unknown or undeclared → { ref: false, none: false }.
// Keyed by the same `runtime_family ?? name` resolution resolveAgent() uses.
```

### `instrument-snapshot` module

```ts
// src/campaign/instrument-snapshot.ts
export interface MaterializeEvalsSnapshotArgs {
  /** This repo's checkout to source the worktree from. */
  readonly evalsCheckout: string;
  readonly evalsSha: string;
  /** Operator's gauntlet checkout to source the worktree from. */
  readonly gauntletCheckout: string;
  readonly gauntletSha: string;
  /** Campaign-local destination (D3: the campaign directory). */
  readonly destDir: string;
  readonly runner: CommandRunner;
}
export interface SnapshotHandle {
  readonly evalsRoot: string;    // <destDir>/evals
  readonly gauntletRoot: string; // <destDir>/gauntlet
  // The registered SHAs both trees must remain HEAD-exact against —
  // verifySnapshot's reference.
  readonly evalsSha: string;
  readonly gauntletSha: string;
}
export function materializeEvalsSnapshot(
  args: MaterializeEvalsSnapshotArgs,
): SnapshotHandle;

export class SnapshotDriftError extends Error {}
/** Throws SnapshotDriftError unless both trees are HEAD-exact and clean. */
export function verifySnapshot(handle: SnapshotHandle, runner: CommandRunner): void;
```

Semantics:

- `evals/`: worktree at the registered evals SHA, then
  `bun install --frozen-lockfile` against the snapshot's `bun.lock` (parent:
  the dependency lockfile is part of the instrument).
- `gauntlet/`: worktree at the registered gauntlet SHA plus gauntlet's build,
  so the campaign child resolves the gauntlet CLI from the snapshot (the
  parent's "the … Gauntlet build execute[s] from a campaign-local
  materialization"). Mechanism: the runner's gauntlet spawn seam resolves the
  binary from the snapshot (PATH overlay or absolute path); the exact site is
  pinned in the implementation plan. **Named highest-uncertainty piece:**
  gauntlet reaches `PATH` via `bun link`/`GAUNTLET_ROOT` today, and
  `GAUNTLET_ROOT` is deliberately absent from the gauntlet child env — the
  snapshot resolution must not reintroduce it there.
- `verifySnapshot`: `HEAD == registered SHA` and `git status --porcelain`
  empty on **both** trees; any drift throws `SnapshotDriftError`. D3 calls it
  per admission wave and maps the error to admission halt + affected-block
  invalidation (parent: "drift detected against registered digests halts
  admission and invalidates the affected block"); that mapping is D3's, the
  typed error is D2's.

### Runner threading

- `RunScenarioArgs.superpowers?: SuperpowersSpec` and a matching `RunHome`
  field carry the value from CLI/child-arg construction into provisioning.
- Threading sites (explicit-wins at each):
  1. **All nine adapters** — consume `home.superpowers` per Decision D-3.
  2. **Setup projection** (`src/setup-step.ts`): explicit root overrides the
     allowlist read; `none` strips `SUPERPOWERS_ROOT` from the setup env.
  3. **Checks projection** (`src/checks/index.ts:27-39`): same rule.
  4. **Context substitution** (`populateContextDir` substitutions, built
     runner-side): `$SUPERPOWERS_ROOT` resolves the explicit root; in `none`
     mode a surviving reference **fails loud** (D1's registration validation
     already excludes `requires_superpowers` conflicts, so a runtime reference
     under `none` is an instrument bug, never a silent empty substitution).
  5. **Provenance probe**: reads the threaded root; `none` →
     `superpowers_rev: null`; the `QUORUM_SUPERPOWERS_REV` container override
     is untouched on the legacy path.
- **CLI projection:** `quorum run --superpowers-root <path>` /
  `--no-superpowers`, mutually exclusive, resolved paths only. No resolution,
  no caching, no validation beyond existence — materialization and
  verification are the caller's (D3's) job, test-driven here through the
  smoke.

## Error handling

Three typed failures, all fail-loud:

- `ProvisioningError` — worktree add failure; HEAD/cleanliness mismatch on
  reuse (never silently reuse a drifted tree).
- `SnapshotDriftError` — `verifySnapshot` failure; D3 maps it to admission
  halt + affected-block invalidation.
- `ProvisionError` (existing class, already maps to setup-stage indeterminate)
  — adapter-level violations: an explicit mode the adapter's registry entry
  denies, or staging machinery failure under `{ mode: 'root' }`.

Invariants: an explicit mode never falls back to host env; the registry is
default-deny; `none` mode encountering a `$SUPERPOWERS_ROOT` reference errors.

## Testing

Repo culture: no mocked-behavior tests. Real tmp git repos as fixtures; the
fake `CommandRunner` records subprocess calls.

Hermetic matrix:

- **Materializer:** `worktree add` called with the exact sha/destParent;
  per-SHA idempotence within one `destParent`; reuse accepted iff HEAD==sha &&
  clean; drifted reuse rejected (`ProvisioningError`); two distinct SHAs yield
  two worktrees.
- **Snapshot:** evals tree gets `bun install`; gauntlet tree gets its build;
  `verifySnapshot` passes on exact+clean and throws on HEAD drift or
  porcelain drift in either tree.
- **Threading:** under `{ mode: 'root' }` the explicit path appears in the
  setup projection, the checks projection, the substitution map, and the
  provenance probe; under `{ mode: 'none' }` staging commands are zero,
  `SUPERPOWERS_ROOT` is absent from both projections, the provenance rev is
  null, and a `$SUPERPOWERS_ROOT` reference fails loud; under `undefined`
  every behavior is byte-identical to today (regression guard for
  Coexistence).
- **Registry:** default-deny for undeclared adapters; claude flagged only
  after the smoke.
- **CLI:** `--superpowers-root`/`--no-superpowers` mutual exclusion and
  pass-through into `RunScenarioArgs`, tested by spawning the real CLI
  (`test/cli-run.test.ts` harness pattern).

Live smoke (trusted-maintainer; claude; one cheap scenario):

1. Materialize a superpowers worktree at a known tag's SHA into a tmpdir;
   `quorum run --superpowers-root <path>`; assert
   `verdict.json .provenance.superpowers_rev` equals that SHA. (Phase 0's
   `replay.ts` already compares `superpowers_rev` against a manifest SHA —
   the readback precedent.)
2. `quorum run --no-superpowers`; assert the provenance rev is null **and** no
   superpowers staging artifacts exist in the run home.

## Coexistence notes

- The container path (`scripts/evals-container` bind-mounts
  `SUPERPOWERS_ROOT` and sets the `QUORUM_SUPERPOWERS_REV` override) is a
  trusted break-glass workflow and rides the `undefined` legacy path
  unchanged; a campaign child never enters it.
- Windows and Antigravity remain separate trusted-maintainer paths (parent
  non-goal); nothing here changes that.
- The dashboard is untouched; campaign runs appear as bare cells until the
  backlog export-adapter lane.

## Exit criteria

- The full hermetic matrix passes; `bun run check` and `bun run quorum check`
  green on the merge commit.
- The claude live smoke passes in both modes with both provenance assertions;
  the registry flags claude.
- D3 is handed, unblocked: `materializeSuperpowersWorktree` (destParent
  parameter = campaign dir), `materializeEvalsSnapshot` + `verifySnapshot`
  (admission drift gate), the `SuperpowersSpec` runner channel with CLI
  projection (child-arg construction), and the default-deny capability
  registry (registration rejection rule).
