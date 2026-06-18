# OS-target dimension (Windows as a first-class eval target)

**Status:** design (2026-06-18)
**Supersedes the agent-shaped Windows runtime in:** `2026-06-17-windows-eval-runtime-design.md`
**Reuses (unchanged):** `WindowsHost`, `RemoteExecution`, the remote-execution runner hooks, `scripts/evals-windows-vm` — all validated live (two passing smokes).

## Problem

The v1 Windows runtime modeled "Windows" as a distinct coding-agent (`claude-windows.yaml` + a `remote` block selecting a `WindowsClaudeAgent`). That works — proven end-to-end live — but it makes the OS a property of a *specific agent*. Adding Codex-on-Windows would mean a `codex-windows.yaml` duplicating the base config plus its own adapter, and so on: an N×M config explosion. The OS the agent runs on is orthogonal to which agent it is, and to which scenario runs. It should be a first-class **target dimension**, so the matrix is **scenario × agent × os** and any agent can declare Windows support without a duplicate config.

The transport and artifact-movement code built for v1 is already agent-agnostic; only *how an agent seeds its config/auth and what its launch command is* are agent-specific. This refactor reframes the selection/config/matrix layer around an OS dimension while reusing that transport code.

## Decisions

1. **`--os <name>` flag, default `linux`.** `linux` is the built-in default (today's local execution; no config file). `windows` is the remote-SSH-to-a-dockur-guest target. `run`, `run-all`, `show`, `costs`, and the dashboard all gain the dimension.
2. **OS targets are config, agents are config, and they compose.** The SSH/remote connection block moves OFF the agent YAML into `os-targets/windows.yaml` (host/port/user/password_env/guest path roots). Agents declare support via `os_support: [linux, windows]` in their YAML (default `[linux]`). `claude.yaml` gains `[linux, windows]`; **`claude-windows.yaml` is deleted**.
3. **`resolveAgent(cfg, os)` resolves a per-`(family, os)` adapter.** For `(claude, linux)` → today's `ClaudeAgent`. For `(claude, windows)` → the v1 `WindowsClaudeAgent` logic, renamed/repositioned as the claude family's Windows provisioner. Selecting an os a family doesn't list in `os_support` fails fast at setup: `agent <name> does not support os target <os>`.
4. **The runner gates on `os`, not `cfg.remote`.** The v1 `cfg.remote !== undefined` gates (substitution merge, push-workdir, capture-back, context-dir selection) become `os === 'windows'` (more generally: "the resolved os-target carries a remote block"). The remote connection comes from the os-target config, threaded to `WindowsHost`/`RemoteExecution`.
5. **Context dir is keyed by `(family, os)`.** `contextDirName(cfg, os)` returns `<family>` for linux and `<family>-<os>` for non-linux — so `(claude, windows)` resolves to the existing `coding-agents/claude-windows-context/` (the launcher + HOWTO are reused unchanged).
6. **Run-id always includes the os** (your call): `<scenario>-<agent>-<os>-<stamp>-<nonce>`. This renames existing linux run dirs going forward; accepted for uniformity.
7. **`run-all` matrix is scenario × agent × os**; the dashboard gains os as a dimension (column/filter); batch dir allocation includes os.
8. **Transport seam reused; provisioning/capture hardened.** `WindowsHost`/`RemoteExecution`/the wrapper are reused, but the per-`(claude, windows)` provisioning and capture take the adversarial-review fixes in the next section. The refactor is selection + config + matrix PLUS those fixes.

## Correctness & security requirements (from adversarial /par review)

Seven real issues an adversarial review found in the v1 code (the green smokes hid #2/#3/#4 because `--dangerously-skip-permissions` masks a broken `.claude.json` and the failure paths weren't exercised). The refactor MUST fix all seven; each is a plan task.

1. **Per-run plugin dir (no shared-dir race).** The guest superpowers checkout moves from a single shared `C:\eval-superpowers` to a per-run path under the run root: `<win_run_root>\<runId>\superpowers`. Each run scp's superpowers into its own dir and points `--plugin-dir` there. This removes the concurrency hazard (concurrent run-all cells were `Remove-Item`+re-scp'ing the shared dir, deleting it under in-flight runs). The os-target config carries `win_run_root` only; the superpowers dir is derived per-run, never a fixed shared path. (Cost: a per-run superpowers scp; the `.git`-stripped tree is seconds.)
2. **No secret in error/argv.** `ANTHROPIC_API_KEY` must never be embedded in a command string that can land in `verdict.json`. Today the launch.cmd write interpolates the key into the `cmd` string, which `ProvisionError` throws verbatim into the persisted verdict on any failure. Fix: write the key to the guest via stdin/base64 (not argv), and the provisioning error must redact (never include) the command payload.
3. **Quoting-safe guest writes.** `.claude.json` and `launch.cmd` must NOT be written by inlining their contents into `powershell -Command "… -Value '<json>'"` — JSON `"`/`'` break the outer command. Write file contents to the guest via base64 (`-EncodedCommand`/`[Convert]::FromBase64String`) or stdin, so arbitrary content (and paths containing quotes) round-trips intact.
4. **Guest-side teardown.** A run's `finally` path must remove the per-run guest root (`ssh Remove-Item -Recurse -Force <win_run_root>\<runId>`), gated on `os === 'windows'`. Without it, every run leaks a tree whose `launch.cmd` holds the plaintext API key (secret-at-rest) and the guest disk fills over a batch.
5. **Capture safe-swap.** `captureBack` must not `rmSync` the local workdir before the pull. Pull the guest workdir into a temp sibling and swap on success, so a pull failure leaves the pre-run fixture intact and recoverable.
6. **Capture failures are `capture`-stage.** A capture-back failure must return a `capture`-stage indeterminate that preserves the gauntlet verdict + pre-check records (like the other capture paths), not throw a bare `Error` that `errorStage()` misattributes to the `unknown` stage (discarding the gauntlet layer).
7. **No-log runs are honest.** If the agent never wrote a session (crash/auth failure), the missing guest `…\.claude\projects` must yield an empty-capture → the normal strict-capture indeterminate, not a hard scp error that masks the real agent failure. Create `projects` during provision, or treat a missing scp source as empty.

## Architecture

```text
quorum run <scenario> --coding-agent claude --os windows
  ├─ load agent cfg (claude.yaml; os_support must include 'windows')
  ├─ load os-target (os-targets/windows.yaml → remote conn block)   [linux: built-in, no remote]
  ├─ resolveAgent(cfg, os) -> (claude, windows) provisioner
  ├─ run-id: <scenario>-claude-windows-<stamp>-<nonce>
  ├─ provision (per-run home + per-run plugin dir; secret-safe base64 writes) ─┐
  ├─ runSetup (build local workdir)                                            │  os === 'windows'
  ├─ push-workdir (scp local -> guest)                                         │  gated
  ├─ gauntlet drive (tmux -> ssh -tt -> guest)                                 │
  ├─ capture-back (scp guest -> local; safe-swap; no-log tolerant)            ─┘
  ├─ guest teardown (rm per-run root)   [run finally, gated on os]
  └─ capture/normalize/checks/verdict (unchanged)
```

For `--os linux` (default), every os-gated branch is skipped → byte-for-byte today's behavior.

## Components

### Config / contracts (`src/contracts/`)
- New `OsTargetSchema` (zod): `name`, plus an optional `remote` block (the v1 `RemoteConfigSchema`, moved here). `linux` needs no file; `os-targets/windows.yaml` provides the windows remote block.
- `AgentConfigSchema`: add `os_support: z.array(z.string()).default(['linux'])`; REMOVE the `remote` block (it moves to the os-target). A loader check: requested os ∈ `os_support` else `CodingAgentConfigError`.
- An os-target loader (mirrors `loadAgentConfig`): `loadOsTarget(dir, name)`; `linux` returns a built-in no-remote target.

### Agent selection (`src/agents/index.ts`)
- `resolveAgent(cfg, os)` → per-`(family, os)` adapter. A small registry: `(family, 'windows')` → the windows provisioner (claude implemented; others throw "unsupported"). `(*, 'linux')` → today's resolution.
- The v1 `WindowsClaudeAgent` is retained as the `(claude, windows)` provisioner; its `provision`/`RemoteExecution` are unchanged except they receive the remote block from the os-target rather than `cfg.remote`.

### CLI (`src/cli/`)
- `run`/`run-all`/`show`/`costs` parse `--os` (run-all: comma list, default `linux`). Validation lives in `quorum check`.

### Runner (`src/runner/`)
- Thread `os` + the resolved os-target into `runScenario`. Replace `cfg.remote` gates with `os === 'windows'` (or `osTarget.remote !== undefined`). `contextDirName(cfg, os)`. Run-id builder includes os.

### Matrix / dashboard (`src/run-all/`, `src/dashboard/`)
- `run-all` iterates scenario × agent × os (filtered by each agent's `os_support`); batch dir + cell identity include os. Dashboard scan/view/templates add os.

### Migration
- Delete `coding-agents/claude-windows.yaml`. `claude.yaml` gains `os_support: [linux, windows]`. Add `os-targets/windows.yaml` (the remote block from the old config). Keep `coding-agents/claude-windows-context/` (now selected by `(claude, windows)`).

## Non-goals

- No new execution/transport code (reuse v1).
- No second agent's Windows support implemented here (claude only); the seam makes it a per-agent `os_support` + provisioner addition.
- No change to linux behavior beyond the run-id name now including `-linux-`.
- No macOS/other os targets yet (the dimension is built general; only linux + windows exist).

## Risks / to verify

1. Run-id rename (`-linux-`) ripples into anything that parses run-dir names (show/costs/dashboard scan, batch grouping). Audit parsers.
2. `run-all`/dashboard are the largest surface; the os dimension must not break existing linux-only batches (default `--os linux` keeps current matrices identical in shape, only names change).
3. Re-validate live after refactor: re-run the two smokes via `--coding-agent claude --os windows` and confirm PASS + correct run-id.

## Verification

Static: `bun run check`, `bun run quorum check`.
Live (trusted-maintainer, Mac orchestrator + tunnel): `quorum run scenarios/00-quorum-smoke-hello-world --coding-agent claude --os windows` and `... triggering-test-driven-development ...` → both PASS, run-ids contain `-windows-`. Record in `docs/experiments/`.

## Implementation phases

1. **Contracts + selection:** OsTargetSchema, `os_support`, `loadOsTarget`, `resolveAgent(cfg, os)`, delete `claude-windows.yaml`, add `os-targets/windows.yaml`, `claude.yaml` os_support. Unit-tested.
2. **Runner:** thread os, re-gate the hooks/substitutions/context-dir on os + os-target remote, run-id includes os.
3. **CLI:** `--os` on run/show/costs.
4. **run-all + dashboard:** os dimension in the matrix, batch allocation, dashboard.
5. **Live re-validation:** the two smokes on `--os windows`; experiment-log entry.
