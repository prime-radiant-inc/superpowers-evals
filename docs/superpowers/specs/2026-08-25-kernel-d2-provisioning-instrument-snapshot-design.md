# Kernel Deliverable 2 — Provisioning + Instrument Snapshot: Design

**Date:** 2026-08-25
**Status:** implemented (pri-2952-kernel-d2 @ cbc24a8+; main merge SHA recorded at merge time)
**Parent spec:** `docs/superpowers/specs/2026-08-17-quorum-campaign-platform-design.md`
  (the campaign platform design; "the parent" below)
**Prerequisite:** Kernel D1 contracts (merged to main @ `41b9e2b`; PRI-2944 done;
  spec `docs/superpowers/specs/2026-08-24-kernel-d1-contracts-design.md`, revision 2)
**Program ticket:** PRI-2874 umbrella (kernel build, order-of-operations item 3,
  deliverable 2 of 4)
**Approach record:** operator design session 2026-08-25 with an independent
  advisor seat (qwen3.8-max); approach A′ adopted (Decisions D-1…D-6 record what
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
what the adapters cannot do today: every adapter is gated on a host-global
`SUPERPOWERS_ROOT` (the nine `CUSTOM_AGENTS` adapters hard-fail in
`provision()`; claude's gate is its `required_env` plus the ambient-root
substitution burned into its launcher), so two arms of one block cannot run
from two different superpowers checkouts on one host. The instrument snapshot
closes the second hole: registration pinning names is not pinning the
instrument — the runner reads `story.md`, `checks.sh`, and the prelude from
mutable paths at run time, so a mid-campaign edit can yield old pre-checks and
new post-checks under a report claiming the registered SHA.

D2 supplies libraries and the primitive; **D3 owns all campaign-directory
layout, registration integration, and dispatcher wiring.** Where this spec
deviates from a first-reading of the parent text it says so (Decisions; D-6
records the one genuine deviation).

## Locked inputs (decisions already made with the operator)

1. **Wire the runner primitive now.** The per-run superpowers root threads
   through the existing runner in D2; D2 is not a library-only deliverable
   waiting for D3's dispatcher.
2. **Acceptance bar:** hermetic gates (fake `CommandRunner` seam) plus **one
   live two-mode smoke**. The per-adapter narrowing — claude only for D2's
   smoke, full per-adapter live sweep at the qualification campaign (parent:
   "Qualification before the first gate") — is a recorded decision (D-4), not
   a locked input.
3. **Approach A′** (advisor-amended): keep the two materializer modules and the
   threading primitive; cut the ad-hoc UX layer (in-runner ref resolution,
   shared worktree cache, per-YAML capability flags, `repoRoot()` override
   seam) as unrequested complexity — see Decisions.

## Code reality this design builds on (verified 2026-08-25)

- The adapter inventory is **ten, not nine**. The nine `CUSTOM_AGENTS`
  adapters (codex, gemini, hermes, pi, copilot, opencode, kimi, antigravity,
  serf) read `SUPERPOWERS_ROOT` via `getEnv` and hard-fail in `provision()` on
  absence. **claude (`ClaudeAgent`, `src/agents/index.ts:107`) never reads it
  in `provision()`** — claude's gate is `required_env: [SUPERPOWERS_ROOT]`
  (`coding-agents/claude.yaml`) enforced runner-side, and claude's consumption
  is the `$SUPERPOWERS_ROOT` substitution (a silent `?? ''` today,
  `src/runner/index.ts:1546`) burned into its launcher
  (`coding-agents/claude-context/launch-agent`: `--plugin-dir
  "$SUPERPOWERS_ROOT"`). For claude that launcher substitution is the **only**
  superpowers channel — `ClaudeAgent.provision` stages no superpowers
  artifacts in either mode. serf's launcher embeds the same
  `--plugin-dir "$SUPERPOWERS_ROOT"` (`coding-agents/serf-context/launch-agent`);
  pi's embeds `--extension`/`--skill` (`coding-agents/pi-context/launch-agent`).
  **claude-windows keeps its legacy ambient read**
  (`src/agents/claude-windows.ts:111-112`; Windows is a non-goal and
  campaign-ineligible).
- The runner-built `$SUPERPOWERS_ROOT` substitution map is **built at
  `src/runner/index.ts:1546`** (today `getEnv('SUPERPOWERS_ROOT') ?? ''`);
  `populateContextDir` (`src/runner/context.ts`) only consumes it — its
  substitutions and its `forbiddenPlaceholders` mechanism are the context-side
  surface. The setup projection (`SETUP_ENV_ALLOWLIST`, `src/setup-step.ts`)
  and the checks projection (`CHECK_ENV_ALLOWLIST`,
  `src/checks/index.ts:27-39`) read the same ambient channel, as does the
  provenance probe.
- **`required_env` is a second ambient gate.** The runner validates every
  agent YAML's `required_env` against the ambient env (`loadAgentConfig`,
  `src/contracts/agent-config.ts:215-224`; invoked at
  `src/runner/index.ts:1245`, re-checked at `src/runner/index.ts:1336`), and
  all ten YAMLs declare `SUPERPOWERS_ROOT`. The repo's own
  `test/cli-run.test.ts` harness seeds a fake `SUPERPOWERS_ROOT` to get past
  this gate — evidence the gate is real. Both explicit modes hit it before
  the threaded value reaches anything.
- `run-all` does **not** call `runScenario` in-process: it spawns `quorum run`
  child processes via `buildChildRunArgs` (`src/run-all/index.ts:180`)
  against the internal run-child entry (`src/cli/run-child.ts`, resolved
  module-side at `src/run-all/index.ts:57`). `RunScenarioArgs`
  (`src/runner/index.ts:380-424`) is the entry shared by the public
  `quorum run` command and that child entry — the parent's "one execution
  primitive" — and already carries
  `credentialsOrigin: 'external-campaign' | 'canonical-snapshot'` in
  anticipation of campaign snapshots. The shared execution primitive is
  therefore the **CLI argv surface**, which is precisely why the CLI
  projection is the right threading surface.
- `RunHome` (`src/agents/index.ts:34-45`) is the established per-run
  provisioning context channel (configDir, workdir, skeletonRoot, scenarioDir);
  adapters consume it in `provision(home, runner, credential?)`.
- `verdict.json .provenance.superpowers_rev` already exists
  (`src/contracts/verdict.ts:81-91`, PRI-2494: nullable, best-effort), so D2's
  black-box acceptance target needs no verdict schema change.
  `QUORUM_SUPERPOWERS_REV` remains the container-path override.
  Reconciliation note (for the E-series ratification, not a text change): as
  built, `superpowers_rev` is nullable-always-present (`null` is the `none`
  representation), with `superpowers_dirty: boolean | null` beside it
  (`src/contracts/verdict.ts:84`).
- `ArmSuperpowersSchema` (`src/contracts/campaign/arm.ts:6-11`), consumed by
  `ArmSchema.superpowers`, admits any non-empty ref or `"none"` and **pins
  tag-vs-SHA disambiguation as D3 registration's job**
  (`resolveSuperpowersRef`).
- `GAUNTLET_ROOT` is deliberately absent from the gauntlet child env
  (`src/runner/gauntlet-env.ts:61-63`); the gauntlet CLI is resolved host-side
  (`PATH` via `bun link`, or `GAUNTLET_ROOT` in the container wrapper), and
  the runner spawns a bare PATH-resolved `gauntlet`
  (`src/runner/index.ts:322`) — no channel today binds the executed binary to
  any snapshot's gauntlet tree.

## Scope

All TDD, repo gates (`bun run check`, `bun run quorum check`) green per commit:

1. **`provisioning` module** (`src/campaign/provisioning.ts`): the superpowers
   worktree materializer and the `none`-mode semantics contract; plus the
   code-level adapter capability registry (homed beside the adapter factory map
   in `src/agents/index.ts` — Decision D-4).
2. **`instrument-snapshot` module** (`src/campaign/instrument-snapshot.ts`):
   the evals+gauntlet campaign-local materializer (including the
   snapshot-local gauntlet wrapper), the `superpowersWorktrees` guard surface,
   and the `verifySnapshot` drift guard.
3. **Runner threading:** `RunScenarioArgs.superpowers` (discriminated union),
   an optional `RunScenarioArgs.gauntletBin`, a `RunHome` carrier field, one
   shared tri-state helper consumed by all adapters, the structured launcher
   placeholder (migrating `coding-agents/{claude,serf,pi}-context/launch-agent`
   off the literal `$SUPERPOWERS_ROOT`), and explicit-wins consumption at
   every ambient read site (adapters, setup projection, checks projection,
   context substitution + launcher expansion, provenance probe, required-env
   resolution).
4. **CLI projection:** `quorum run --superpowers-root <path>` and
   `--no-superpowers` (mutually exclusive; resolved paths only, no ref
   resolution) landing in **both** Commander parsers — the public
   `quorum run` command and the internal run-child (`src/cli/run-child.ts`) —
   plus `RunCommandOptions`, `executeRunCommand`, and the campaign
   child-argv builder — the "child-arg construction" surface D3's spawned
   campaign children will use.
5. **Acceptance evidence:** the hermetic matrix of section "Testing", plus one
   live claude smoke in both modes asserting the provenance readback and the
   behavioral launcher assertions.

## Non-goals

- **No ref→SHA resolution in the runner.** Pinned to D3 registration by
  `arm.ts`. A second resolver duplicates the seam; a campaign child receiving a
  ref would re-materialize inside the child that admission was supposed to
  gate. The runner receives a resolved root path or `none`, never a ref.
- **No shared/ad-hoc worktree cache.** The parent pins worktree placement under
  the campaign directory; the materializer takes a caller-supplied `destParent`
  (D3 passes the campaign dir; tests and the smoke pass a tmpdir). A cache can
  layer on later without touching D3.
- **No `repoRoot()` override seam.** `repoRoot()` is `import.meta.url`-based
  (`src/paths.ts:12-15`) — cwd is irrelevant; only executing the snapshot's
  own code resolves it. D3 spawns campaign children with cwd inside the
  snapshot **and** child-argv addressing the snapshot's own entrypoint
  (Decision D-5 pins this; cwd alone is insufficient).
- **No campaign-dir layout, registration integration, or dispatcher wiring**
  (D3). D2's modules are libraries plus the runner primitive.
- **No per-YAML capability flags.** Capability is a fact about adapter code; a
  YAML claim can drift from implementation, and a false "supported" claim is
  the "up and lying" failure class. The registry is code-level, default-deny.
- **`run-all`, the appliance, the dashboard, the container path, and Windows
  provisioning are untouched** (parent Coexistence; `os: windows` stays a
  registration error). Explicit superpowers modes combined with `--os windows`
  on the CLI fail loud (mixed-state rejection); claude-windows keeps its
  legacy ambient read. Threading leaves the `undefined` (legacy) path
  byte-for-byte behavior-identical.
- **No verdict schema change.** The existing nullable `provenance` block
  carries the acceptance evidence.

## Decision D-1: materialization is a library; threading is the runner primitive

These are separate concerns and D2 keeps them separate. The materializers know
nothing about runs; the runner threading knows nothing about materialization —
it receives an already-materialized root (or `none`). The parent's "the
dispatcher materializes one immutable worktree per distinct SHA under the
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
  the launcher placeholder expands to nothing (flags elided);
  `SUPERPOWERS_ROOT` is stripped from the setup/checks projections and
  suppressed as a `required_env` requirement; the provenance rev reads null.
  Absence-of-env is *not* the none signal (that reinterpretation would turn a
  forgotten env var into a silent stock-agent run — the silent-mislabel class
  behind the $650 discredited gate and the $850 re-gate).
- `{ mode: 'root' }` — **explicit root**: every read site uses it.

Adapter consumption goes through **one shared tri-state helper**,
`resolveSuperpowersRoot(home)`: `root` → the threaded root; `none` → skip
staging; `undefined` → `getEnv('SUPERPOWERS_ROOT')`. Explicit wins, legacy
fallback preserved, and no ten open-coded ternaries. All ten adapters are
touched once, now — the parent's "sized honestly — it touches all 9 adapters"
undercounts the as-built inventory (nine `CUSTOM_AGENTS` plus claude; see Code
reality).

## Decision D-4: the capability registry is code-level and default-deny

Per adapter family, a declared `{ ref: boolean; none: boolean }` capability set
living beside the factory map in `src/agents/index.ts` (the registry D1 pinned
as "D1 pins the registry seam, D2 fills it"). Absence means unsupported.

The registry API takes the **loaded `AgentConfig`** (or an already-resolved
runtime-family string), never a bare name looked up from disk — keyed by
`runtime_family ?? name` exactly as `resolveAgent` computes it
(`src/agents/index.ts:383`). If it ever loads by name, it uses the static
loader and never triggers ambient `required_env` or CLI-version probes.

D2 flags **claude only** — it is the smoke-tested adapter. Each further
adapter's registry flip is a platform PR carrying the same two-mode live smoke
as claude's (the parent's per-adapter black-box provenance readback test),
landed between D2 and the qualification campaign. Without this, D3
registration — which reads the registry to reject `none`/ref arms for unproven
agents (parent: "Registration rejects `none`/ref arms for agents whose adapter
has not implemented the mode") — would reject the arms qualification needs to
exercise, and no adapter but claude could ever qualify.

The acceptance-bar narrowing lives here as a recorded decision (moved out of
Locked inputs): D2's live smoke is claude's; the full per-adapter live sweep
rides the qualification campaign (parent: "Qualification before the first
gate").

## Decision D-5: no `repoRoot()` seam; campaign children execute the snapshot's own entrypoint

`repoRoot()` derives from the module's own URL (`src/paths.ts:12-15`), so cwd
is irrelevant — only executing the snapshot's own code resolves every
scenario/prelude/config path against the snapshot for free, and `bun run`
walks up to the snapshot's `package.json` / frozen lockfile. The precondition
is therefore **pinned, not assumed**: campaign children execute the snapshot's
own entrypoint — `<evalsRoot>/src/cli/...` addressed explicitly in child-argv
construction (e.g. `bun run <evalsRoot>/src/cli/index.ts run …`, with cwd
inside the snapshot). A PATH-resolved or host-checkout quorum binary is
forbidden for campaign children. The current internal run-child construction
resolves an absolute module-derived path (`INTERNAL_RUN_ENTRY`,
`src/run-all/index.ts:57`) and would execute the **originating** checkout even
with cwd changed — silently defeating the instrument snapshot while
`verifySnapshot` stays green. D3-facing note: the internal run-child argv
builder is amended to address the snapshot entrypoint. D2 builds and verifies
the snapshot; D3 owns spawn. This deletes the apparent "runner must learn to
run from an arbitrary root" complexity.

## Decision D-6: explicit-args threading replaces the parent's env injection (recorded deviation)

The parent delivers the per-child superpowers root by ambient env injection;
this spec threads it as an explicit argument on the shared execution
primitive. This is a deviation from the parent text and is recorded here with
its rationale: env absence is indistinguishable from a forgotten
`SUPERPOWERS_ROOT` (re-creating the silent-mislabel class `none` exists to
prevent); the container path already sets ambient env; and the three states
(`undefined` / `root` / `none`) are load-bearing and cannot be projected
through ambient env alone.

Parent passages, quoted: Provisioning — the dispatcher "passes its root per
child (env injection through the existing `command-runner` seam)"; Identity —
"this is the one required runner change". D1 handed this downstream as "the
per-child env injection contract over `command-runner`"; D1's
downstream-interfaces row gets a matching one-line revision note ("per-child
superpowers delivery contract (explicit runner argument; parent erratum E6)").

Proposed parent erratum (E6, for ratification on PRI-2874 alongside the D1
errata):

> **E6 — per-child superpowers delivery mechanism.** In Provisioning, "(env
> injection through the existing `command-runner` seam)" is replaced by: "as an
> explicit argument on the shared execution primitive
> (`RunScenarioArgs.superpowers`: `{mode:'root', root}` | `{mode:'none'}`; CLI
> projection `--superpowers-root`/`--no-superpowers` for spawned campaign
> children), projected by the runner into the setup/checks child env. Ambient
> env injection is retired for campaign children: env absence cannot be
> distinguished from a forgotten `SUPERPOWERS_ROOT`, re-creating the
> silent-mislabel class that `none` exists to prevent." In Identity, "this is
> the one required runner change" becomes "this is the one required runner
> change for campaign identity stamping; the D2 superpowers threading is a
> second, separately specced runner change."

## Contracts

### `provisioning` module

```ts
// src/campaign/provisioning.ts
export interface MaterializeSuperpowersArgs {
  /** Local superpowers checkout to source the worktree from. */
  readonly sourceCheckout: string;
  /** Resolved full SHA (refs never reach here — Decision D-2); validated as
   *  full hex (40/64) before any path construction. */
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
  through the `CommandRunner` seam (hermetic-testable). **Every `CommandRunner`
  call inside both materializers passes an explicit minimal env (`PATH`,
  `HOME`, `TMPDIR` only)** — the runner seam's documented invariant forbids
  inheriting the parent env.
- **Idempotent per SHA within `destParent`** — this *is* the parent's "one
  immutable worktree per distinct SHA." A pre-existing path is reused only if
  `HEAD == sha` and `git status --porcelain` is empty; anything else throws
  `ProvisioningError`. A drifted tree is never silently reused.
  Existence/reuse checks use `lstat` semantics — a symlinked pre-existing path
  is never reused (throw) — mirroring `src/campaign/acquire.ts`'s
  `isValidRunId`/`tryLstat` idiom by name.
- **Failure cleanup:** on failure, clean up — `git worktree remove --force` on
  the created worktree and `git worktree prune` on the source — never `rm -rf`
  (worktree registrations live in the source checkout's `.git/worktrees`).
- **Single-flight per `(destParent, sha)`:** the materializer takes a lockfile
  (`O_EXCL` create of `<dest>.lock`, stale-lock detection by mtime);
  concurrent same-SHA calls — one materializes, the other waits and then
  reuses. Part of the module contract.
- The worktree is immutable post-materialization: nothing in quorum writes to
  it; drift detection on reuse (and D3's `verifySnapshot` cadence, below) is
  the guard.
- The `none`-mode semantics contract is exported from here and consumed by the
  threading layer: zero skill/plugin/hook staging, the launcher placeholder
  expands to nothing (flags elided), `SUPERPOWERS_ROOT` absent from child env
  projections, provenance rev null.

### Capability registry

```ts
// src/agents/index.ts, beside CUSTOM_AGENTS
export interface SuperpowersCapability {
  readonly ref: boolean;
  readonly none: boolean;
}
export function superpowersCapability(
  config: AgentConfig | string,
): SuperpowersCapability;
// Takes the loaded AgentConfig (or an already-resolved runtime-family string),
// never a bare name looked up from disk — keyed by `runtime_family ?? name`
// exactly as resolveAgent() computes it (src/agents/index.ts:383). Any
// by-name loading uses the static loader and never triggers ambient
// required_env or CLI-version probes. Default-deny: unknown or undeclared →
// { ref: false, none: false }.
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
export interface SuperpowersWorktreeRef {
  readonly root: string;
  readonly sha: string;
}
export interface SnapshotHandle {
  readonly evalsRoot: string;    // <destDir>/evals
  readonly gauntletRoot: string; // <destDir>/gauntlet
  /** Absolute path to the snapshot-local gauntlet wrapper (see semantics). */
  readonly gauntletBin: string;
  /** Superpowers worktrees verifySnapshot guards; empty for library-only
   *  use — D3 populates one entry per distinct arm SHA. */
  readonly superpowersWorktrees: readonly SuperpowersWorktreeRef[];
  // The registered SHAs the evals and gauntlet trees must remain HEAD-exact
  // against — verifySnapshot's reference.
  readonly evalsSha: string;
  readonly gauntletSha: string;
}
export function materializeEvalsSnapshot(
  args: MaterializeEvalsSnapshotArgs,
): SnapshotHandle;

export class SnapshotDriftError extends Error {}
/** Throws SnapshotDriftError unless every tree — evals, gauntlet, and each
 *  superpowers worktree — is HEAD-exact and porcelain-clean. */
export function verifySnapshot(handle: SnapshotHandle, runner: CommandRunner): void;
```

Semantics:

- `evals/`: worktree at the registered evals SHA, then
  `bun install --frozen-lockfile` against the snapshot's `bun.lock` (parent:
  the dependency lockfile is part of the instrument). **Re-entry marker:**
  reuse of the snapshot requires an install/build success marker
  (`.quorum-snapshot-ok`, written only after `bun install` and the gauntlet
  wrapper build succeed; an absent marker re-runs those steps — they are
  idempotent). **Crash-resume:** `SnapshotHandle` is reconstructible from the
  campaign-dir contents alone — roots and `gauntletBin` re-derived
  deterministically from the `destDir` layout, SHAs re-read from the per-tree
  worktree HEADs — and the module docs state exactly what is re-derived and
  how.
- `gauntlet/`: worktree at the registered gauntlet SHA plus gauntlet's build,
  so the campaign child resolves the gauntlet CLI from the snapshot (the
  parent's "The dispatcher, scenarios, checks, prelude, agent configs,
  dependency lockfile, and Gauntlet build execute from a campaign-local
  materialization of the registered evals SHA"). **Mechanism (pinned,
  mirroring the container's approach at `container/Dockerfile:33`):**
  `materializeEvalsSnapshot` constructs a snapshot-local wrapper —
  `bun install --frozen-lockfile` in the gauntlet tree, then a wrapper script
  exposed as `gauntletBin`:

  ```sh
  #!/bin/sh
  exec bun <gauntletRoot>/src/index.ts "$@"
  ```

  (Entrypoint verified against the container Dockerfile, whose wrapper execs
  `bun /opt/gauntlet/src/index.ts "$@"`; the implementer re-verifies at build
  time.) Appendix B's `refs: {superpowers_by_arm, evals, gauntlet}` exists
  precisely for this materialization; D1's seam-map consumes-column extends to
  `Campaign.refs.{evals,gauntlet}`. The parent's "drift detected against
  registered digests" is implemented as HEAD-equality + porcelain-clean per
  worktree (equivalent; porcelain is blind to ignored paths — see the caveat
  under `verifySnapshot`). **Named highest-uncertainty piece:** gauntlet
  reaches `PATH` via `bun link`/`GAUNTLET_ROOT` today, and `GAUNTLET_ROOT` is
  deliberately absent from the gauntlet child env — the snapshot resolution
  must not reintroduce it there.
- **`gauntletBin` runner threading:** `RunScenarioArgs` gains an optional
  `gauntletBin: string`. When present, the gauntlet spawn seam (today a bare
  PATH-resolved `gauntlet`, `src/runner/index.ts:322`) and the
  `versionLine('gauntlet', …)` provenance probe both use it; when absent,
  legacy PATH resolution, unchanged.
- `superpowersWorktrees`: empty for library-only use; D3 populates one entry
  per distinct arm SHA. Uncommitted edits leave HEAD at the registered SHA —
  provenance readback alone gates nothing — so `verifySnapshot` is the drift
  guard for the superpowers worktrees, the treatment variable of the parent's
  headline questions. `superpowers_dirty` remains recorded best-effort in
  provenance but is not the gate — the gate is `verifySnapshot`.
- `verifySnapshot`: `HEAD == registered SHA` and `git status --porcelain`
  empty on **all three tree families** (evals, gauntlet, and each superpowers
  worktree); drift in any tree throws `SnapshotDriftError`. Porcelain caveat:
  porcelain is blind to ignored-path mutation; materialization must keep its
  outputs (installs, builds, the wrapper) in gitignored paths or
  `verifySnapshot` false-fires — gauntlet-repo output hygiene is asserted
  once, live, during the qualification campaign.
- **Calling contract handed to D3 (cadence):** `verifySnapshot` fires **per
  admission wave, at block terminal (before a block's verdicts journal
  terminal), and pre-seal (before the report seals)**. The pre-seal call
  closes the final-wave hole (after the last admission wave no verify would
  otherwise ever fire again — and longest-expected-first dispatch puts the
  slow cells last); block-terminal bounds in-flight exposure to one block.
  Accepted residual, recorded: drift landing between a run's story read and
  its post-checks within one block interval remains possible (it requires
  active mid-run mutation of a campaign-local tree — operator action or
  scenario mischief); the block-terminal verify + manifest multiset guard +
  dirty provenance bound it, and drift detected at any point invalidates the
  affected block range per D3's mapping. No new runner threading in D2 for
  this — the cadence is D3's call sites over D2's function.
- D3 maps `SnapshotDriftError` — and a re-materialization `ProvisioningError`
  raised on resume/per-wave — to admission halt + affected-block invalidation
  (parent: "drift detected against registered digests halts admission and
  invalidates the affected block"); that mapping is D3's, the typed errors are
  D2's.

### Runner threading

- `RunScenarioArgs.superpowers?: SuperpowersSpec` and a matching `RunHome`
  field carry the value from CLI/child-arg construction into provisioning;
  `RunScenarioArgs.gauntletBin?: string` carries the snapshot-local gauntlet
  wrapper (above).
- **One shared tri-state helper**, `resolveSuperpowersRoot(home)`, is consumed
  by all ten adapters (Decision D-3) — no per-adapter open-coded ternaries.
- **Structured launcher placeholder:** the claude/serf/pi launcher templates
  migrate from a literal `$SUPERPOWERS_ROOT` to a mode-aware placeholder
  (`$SUPERPOWERS_PLUGIN_ARGS`) that the runner expands per mode — root → the
  agent-family-specific flags pointing at the threaded root
  (`--plugin-dir <root>` for claude/serf; `--extension <root> --skill
  <root>/skills` for pi); none → the flags are **elided** (never
  empty-substituted); undefined → today's expansion (legacy,
  byte-identical). Touch list: `coding-agents/{claude,serf,pi}-context/launch-agent`.
- Threading sites (explicit-wins at each):
  1. **All ten adapters** — consume `home.superpowers` via
     `resolveSuperpowersRoot` per Decision D-3: the nine `CUSTOM_AGENTS`
     adapters in `provision()`; claude via the launcher substitution (this
     site), the required-env resolution (site 6), and the provenance probe.
  2. **Setup projection** (`src/setup-step.ts`): explicit root overrides the
     allowlist read; `none` strips `SUPERPOWERS_ROOT` from the setup env.
  3. **Checks projection** (`src/checks/index.ts:27-39`): same rule.
  4. **Context substitution + launcher expansion** (substitutions built
     runner-side at `src/runner/index.ts:1546`, consumed by
     `populateContextDir`, `src/runner/context.ts`): `$SUPERPOWERS_ROOT`
     resolves the explicit root; `$SUPERPOWERS_PLUGIN_ARGS` expands per mode
     (above). In `none` mode a surviving **raw** `$SUPERPOWERS_ROOT` reference
     anywhere in populated context — launcher or scenario-authored content —
     **fails loud**, via the existing `forbiddenPlaceholders` mechanism in
     `populateContextDir`. Post-migration, a surviving raw reference means an
     instrument bug, which is what the rule exists to catch. (The
     `requires_superpowers` exclusion is a D3 registration filter that does
     not exist when D2 ships; until then this fail-loud substitution is the
     only guard.)
  5. **Provenance probe**: reads the threaded root; `none` →
     `superpowers_rev: null`. `QUORUM_SUPERPOWERS_REV` is honored **only on
     the legacy path** (`superpowers` undefined); under an explicit mode its
     presence is a misconfiguration → loud error at run start (it would
     otherwise stamp a rev the run never used).
  6. **Required-env resolution** (`loadAgentConfig`,
     `src/contracts/agent-config.ts:215-224`; invoked
     `src/runner/index.ts:1245`, re-checked `:1336`): one runner-owned
     validation against the **effective** environment — root mode: the
     explicit root satisfies a `SUPERPOWERS_ROOT` requirement; none mode:
     that requirement is suppressed; undefined: ambient, unchanged. The
     duplicate checks reconcile: load statically via `loadAgentConfig`,
     validate once runner-side against the effective env.
- **CLI projection:** `quorum run --superpowers-root <path>` /
  `--no-superpowers`, mutually exclusive, resolved paths only, landing in
  **both** Commander parsers — the public `quorum run` command and the
  internal run-child (`src/cli/run-child.ts`) — plus `RunCommandOptions`,
  `executeRunCommand`, and the campaign child-argv builder (the
  `buildChildRunArgs` analog, `src/run-all/index.ts:180`), with focused tests
  for public parsing and canonical-child forwarding. Explicit modes combined
  with `--os windows` fail loud (mixed-state rejection). No resolution, no
  caching, no validation beyond existence — materialization and verification
  are the caller's (D3's) job, test-driven here through the smoke.

## Error handling

Three typed failures, all fail-loud:

- `ProvisioningError` — worktree add failure; HEAD/cleanliness mismatch on
  reuse (never silently reuse a drifted tree); malformed `sha`; a symlinked
  pre-existing destination; and re-materialization failures on resume/per-wave
  (D3 maps these to admission halt exactly like `SnapshotDriftError`).
- `SnapshotDriftError` — `verifySnapshot` failure on any of the three tree
  families; D3 maps it to admission halt + affected-block invalidation.
- `ProvisionError` (existing class, already maps to setup-stage indeterminate)
  — adapter-level violations: an explicit mode the adapter's registry entry
  denies, or staging machinery failure under `{ mode: 'root' }`.

Plus two loud-at-start rejections: `QUORUM_SUPERPOWERS_REV` set under an
explicit superpowers mode (would stamp a rev the run never used), and an
explicit mode combined with `--os windows` (mixed-state rejection).

Invariants: an explicit mode never falls back to host env; the registry is
default-deny; `none` mode encountering a raw `$SUPERPOWERS_ROOT` reference in
populated context errors (via `forbiddenPlaceholders`).

## Testing

Repo culture: no mocked-behavior tests. Real tmp git repos as fixtures; the
fake `CommandRunner` records subprocess calls.

Hermetic matrix:

- **Materializer:** `worktree add` called with the exact sha/destParent;
  per-SHA idempotence within one `destParent`; reuse accepted iff HEAD==sha &&
  clean; drifted reuse rejected (`ProvisioningError`); two distinct SHAs yield
  two worktrees; non-hex `sha` rejected before any path construction; a
  symlinked pre-existing destination never reused (throws); hostile
  credential env vars seeded in the parent never reach the child seam
  (minimal-env projection); on failure the worktree is removed
  (`--force` + `prune`, never `rm -rf`); an absent `.quorum-snapshot-ok`
  re-runs install/wrapper build (idempotent); concurrent same-SHA calls
  single-flight — one materializes, the other waits then reuses; a stale lock
  is reclaimed by mtime.
- **Snapshot:** evals tree gets `bun install`; gauntlet tree gets its wrapper
  (`gauntletBin` execs the snapshot's gauntlet entrypoint);
  `verifySnapshot` passes on exact+clean and throws on HEAD drift or porcelain
  drift in **any** tree (evals, gauntlet, each superpowers worktree); a decoy
  `gauntlet` earlier on `PATH` is never executed when `gauntletBin` is set.
- **Threading:** under `{ mode: 'root' }` the explicit path appears in the
  setup projection, the checks projection, the substitution map, the
  provenance probe, and the expanded launcher flags (`--plugin-dir` /
  `--extension` / `--skill` pointing at the threaded root); under
  `{ mode: 'none' }` staging commands are zero, `SUPERPOWERS_ROOT` is absent
  from both projections, the launcher superpowers flags are elided (not
  empty-substituted), the provenance rev is null, a raw `$SUPERPOWERS_ROOT`
  reference fails loud, and the run does not demand ambient
  `SUPERPOWERS_ROOT` (required-env suppressed); a root-mode run passes with
  ambient `SUPERPOWERS_ROOT` unset; `QUORUM_SUPERPOWERS_REV` set under an
  explicit mode errors at run start; under `undefined` every behavior is
  byte-identical to today, launcher expansion included (regression guard for
  Coexistence).
- **Registry:** keyed by `runtime_family ?? name`; default-deny for undeclared
  adapters; claude flagged only after the smoke.
- **CLI:** `--superpowers-root`/`--no-superpowers` mutual exclusion and
  pass-through into `RunScenarioArgs` in **both** parsers (public `quorum run`
  and the internal run-child) plus canonical-child forwarding, tested by
  spawning the real CLI (`test/cli-run.test.ts` harness pattern); hostile
  test — originating checkout differs from the snapshot: the child reports
  the snapshot's paths, proving only snapshot content executes (Decision D-5).

Live smoke (trusted-maintainer; claude; one cheap scenario). **Precondition:**
ambient `SUPERPOWERS_ROOT` is set **and** its HEAD differs from the smoke SHA —
otherwise the provenance readback can pass vacuously (a run that silently used
the ambient root would stamp the same SHA).

1. Materialize a superpowers worktree at a known tag's SHA into a tmpdir;
   `quorum run --superpowers-root <path>`; assert
   `verdict.json .provenance.superpowers_rev` equals that SHA **and**,
   behaviorally, that the retained substituted launcher in the run dir
   (`<runDir>/gauntlet-agent/context/launch-agent`) burns in a plugin path
   equal to the materialized worktree. (Phase 0's `replay.ts` already compares
   `superpowers_rev` against a manifest SHA — the readback precedent.)
2. `quorum run --no-superpowers`; assert the provenance rev is null **and**
   the retained launcher carries no plugin-dir / extension / skill flags —
   behavioral, not artifact-counting (claude stages no superpowers artifacts
   in either mode, so artifact absence is vacuous for claude).

Smoke and D3-handoff teardown: `git worktree remove` / `git worktree prune`,
never `rm -rf` — worktree registrations live in the source checkout's
`.git/worktrees`.

## Coexistence notes

- The container path (`scripts/evals-container` bind-mounts
  `SUPERPOWERS_ROOT` and sets the `QUORUM_SUPERPOWERS_REV` override) is a
  trusted break-glass workflow and rides the `undefined` legacy path
  unchanged; a campaign child never enters it.
- Windows and Antigravity remain separate trusted-maintainer paths (parent
  non-goal); nothing here changes that. Explicit superpowers modes combined
  with `--os windows` fail loud (mixed-state rejection); claude-windows keeps
  its legacy ambient read.
- The dashboard is untouched; campaign runs appear as bare cells until the
  backlog export-adapter lane.

## Exit criteria

- The full hermetic matrix passes; `bun run check` and `bun run quorum check`
  green on the merge commit.
- The claude live smoke passes in both modes — provenance readback plus the
  behavioral launcher assertions — under the differing-HEAD precondition; the
  registry flags claude.
- D3 is handed, unblocked: `materializeSuperpowersWorktree` (destParent
  parameter = campaign dir; failure-cleanup and single-flight contract),
  `materializeEvalsSnapshot` + `verifySnapshot` (all three tree families;
  admission drift gate; the per-admission-wave / block-terminal / pre-seal
  cadence contract), `SnapshotHandle` with `gauntletBin` and
  `superpowersWorktrees` (and the crash-resume reconstruction contract), the
  `SuperpowersSpec` runner channel with CLI projection in both parsers
  (child-arg construction addressing the snapshot's own entrypoint per
  Decision D-5), the `gauntletBin` threading, and the default-deny capability
  registry (registration rejection rule; flip PRs between D2 and
  qualification).
