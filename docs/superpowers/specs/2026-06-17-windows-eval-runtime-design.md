# Windows eval runtime (native-Windows Coding-Agent)

**Status:** design (2026-06-17)
**Builds on:** `2026-06-15-container-runtime-design.md`, `2026-06-15-per-run-home-isolation.md`

## Problem

Superpowers ships Windows-specific behavior — the polyglot `run-hook.cmd`
hook wrappers and the `docs/windows/` guidance — but quorum can only exercise
Coding-Agents on macOS/Linux. We cannot currently prove that skills
auto-trigger and that hooks actually fire when Claude Code runs natively on
Windows. That is the one risk Windows uniquely exposes, and it is invisible to
every existing eval.

We want a **standalone, documented** runtime that runs a quorum scenario with the
Coding-Agent executing on a real Windows 11 guest, while keeping quorum's
existing verdict contract: the same `verdict.json`, the same
`gauntlet-agent/results/**`, the same captured transcript, scored by the same
deterministic checks. This is the Windows sibling of the Linux `container/`
runtime, not a replacement for it.

## What the spike proved (2026-06-17)

A throwaway spike on `magic-kingdom` (the only viable host class — see "Host"
below) settled the architecture:

- **gauntlet's existing tmux `tui` adapter drives native-Windows Claude with no
  gauntlet change.** Proven chain: `tmux` (Linux) → `ssh -tt` → Windows
  `claude.ps1`. Claude received a real PTY through the SSH chain, rendered its
  trust prompt and full interactive UI, and `tmux capture-pane` read the screen
  back cleanly. gauntlet's tui adapter merely opens a `bash` pane and lets the
  QA agent type a launch command into it; the launch command is the only thing
  that has to change.
- **Running the harness *inside* Windows is a swamp, and we are not doing it.**
  In the guest, `tmux` is absent and `bash` on `PATH` is WSL
  (`C:\WINDOWS\system32\bash.exe`), not Git Bash. Driving Claude's TUI would
  require either tmux under Cygwin/MSYS2 (a known rendering hazard with native
  console apps) or a PTY-less pipe. Putting tmux on Linux, where it already
  works, avoids all of it.
- **The Windows guest already has** Node 22, Git + Git Bash, and Claude Code
  v2.1.150. Bun is absent (we do not need it — quorum runs on Linux).
- **`--plugin-dir` is the install path, not the marketplace.** The Linux
  launcher loads superpowers with `--plugin-dir "$SUPERPOWERS_ROOT"`. The guest's
  empty `enabledPlugins` is therefore irrelevant: provisioning only has to place
  the superpowers checkout on the Windows filesystem and point `--plugin-dir` at
  it. That is exactly what exercises `run-hook.cmd`.
- **SSH mux gotcha.** `magic-kingdom`'s `ControlMaster` silently multiplexes
  `ssh -p 2222 user@localhost` back onto the host. Every connection to the guest
  MUST pass `-o ControlMaster=no -o ControlPath=none`.

## Host

dockur/windows boots a real Windows 11 VM via QEMU/KVM and **requires
`/dev/kvm`**. It cannot run on this macOS workstation (no KVM passthrough on
Apple-Silicon Docker). The Windows runtime is therefore **Linux-only** and is
documented as such. It must not hard-code one machine: connection parameters
(host, SSH port, credentials, container name, VM directory) are configurable, so
it works on `magic-kingdom` or any other Linux+KVM host.

## Decisions

1. **Linux orchestrates; Windows executes (Arch 2).** gauntlet and quorum run on
   Linux. The dockur Windows VM is a sibling. The Coding-Agent runs natively on
   Windows, driven over SSH. We do not run gauntlet or quorum inside Windows.
2. **Reproduce the local artifact layout.** A Windows run lands its evidence in
   the *same* local paths a Linux run uses — `<run>/home/.claude/projects/**`
   for session logs and `<run>/coding-agent-workdir/**` for the workdir —
   populated via SSH+scp. Capture, normalization, the strict-capture cascade,
   and every deterministic check then run **unchanged** on Linux. This principle
   is what keeps the change small and parity-safe.
3. **SSH is the only channel.** Driving (already proven) and capture-back both
   use the same SSH connection. We explicitly reject the dockur `\\host.lan\Data`
   shared folder: it is documented but flaky (dockur issues #420/#644/#668), and
   reusing the proven SSH channel adds zero new failure modes. Payloads are tiny
   (a Go program, a todo app).
4. **`--plugin-dir`, not marketplace.** Provisioning rsyncs the superpowers
   checkout to a cached Windows path and passes `--plugin-dir <win-path>`,
   mirroring the Linux launcher. No marketplace enable, no per-run plugin
   install.
5. **API-key auth, not the operator's OAuth.** The Windows session authenticates
   with a per-run `ANTHROPIC_API_KEY`, matching the Linux Claude adapter. The
   spike's interactive login used the operator's Max subscription; evals must
   not.
6. **Claude required for v1; the seam is general.** v1 ships `claude-windows`
   working end-to-end. The remote-host abstraction and Windows provisioning seam
   are built so a future `codex-windows` (etc.) is an incremental addition, not
   a rewrite.
7. **Minimal core-runner surgery.** Exactly one new runner seam: a post-drive,
   pre-post-snapshot capture-back step. Everything else rides existing seams
   (agent config, per-agent context HOWTO/launcher, `provision()`).

## Architecture

A Windows run is a normal quorum run with three Windows-specific touch points.
The numbered steps map to quorum's existing phase order; the **bold** ones are
new.

1. **Ensure VM (new).** Before the run, confirm the dockur container is up and
   the guest's `sshd` answers (mux disabled). Fail fast with a clear message if
   not.
2. **Provision (new, over SSH).** Replaces the local `ClaudeAgent.provision`
   filesystem seeding with its SSH analog:
   - create a per-run Windows tree `C:\eval-runs\<runId>\{home,workdir}`;
   - clone the scenario fixture into `…\workdir` (the prepared git repo);
   - seed `…\home\.claude\.claude.json` with the project-trust block and the
     API-key approval fingerprint (the same JSON the Linux adapter writes);
   - place the per-run `ANTHROPIC_API_KEY` so the launcher can export it;
   - ensure the superpowers checkout is present at a cached Windows path
     (`C:\eval-superpowers`), rsync'd from `SUPERPOWERS_ROOT` and refreshed only
     when changed.
3. **Drive (existing gauntlet).** gauntlet opens its normal tmux `bash` pane on
   Linux. The QA agent reads the substituted `claude-windows-context/HOWTO.md`
   and types the one-token launcher `"$QUORUM_LAUNCH_AGENT"`. That launcher is a
   **Linux** bash script that `ssh -tt`'s into the guest and runs native Claude
   with HOME/USERPROFILE pinned to the per-run Windows home. The TUI renders in
   the pane; the QA agent drives and self-grades exactly as today.
4. **Capture-back (new runner seam).** After the agent exits and **before**
   quorum's post-run session-log snapshot, scp the guest's
   `…\home\.claude\projects\**` into `<run>/home/.claude/projects/**` and
   `…\workdir\**` into `<run>/coding-agent-workdir/**`.
5. **Capture / checks / verdict (existing).** The pre/post snapshot diff now sees
   the scp'd logs as "new"; capture → normalize → ATIF → strict-capture cascade
   → `pre()`/`post()` checks → composer all run on Linux unchanged.

### Data flow at a glance

```text
Linux (orchestrator)                         Windows guest (dockur, KVM)
────────────────────                         ───────────────────────────
quorum runScenario
  ├─ ensure VM (ssh probe) ───────────────▶  sshd up?
  ├─ provision (ssh/scp)  ────────────────▶  C:\eval-runs\<id>\{home,workdir}
  │                                           seed .claude.json, api key
  │                                           ensure C:\eval-superpowers (rsync)
  ├─ gauntlet (tmux bash pane)
  │     └─ QA types "$QUORUM_LAUNCH_AGENT"
  │           └─ launch-agent: ssh -tt ───▶  claude --plugin-dir C:\eval-superpowers
  │                                           HOME=…\home  (renders in pane)
  ├─ capture-back (scp)  ◀────────────────   …\home\.claude\projects, …\workdir
  │     → <run>/home/.claude/projects
  │     → <run>/coding-agent-workdir
  └─ capture/normalize/checks/compose  (unchanged, Linux-local)
```

## Components

Each unit is independently understandable and testable.

### 1. VM lifecycle wrapper — `scripts/evals-windows-vm`

The dockur sibling of `scripts/evals-container`. Commands:

```bash
scripts/evals-windows-vm up        # docker start (or create) + wait for guest sshd
scripts/evals-windows-vm down      # docker stop
scripts/evals-windows-vm status    # container state + sshd reachability
scripts/evals-windows-vm ssh [cmd] # one mux-disabled SSH into the guest
scripts/evals-windows-vm sync-superpowers   # rsync SUPERPOWERS_ROOT -> guest cache
```

Owns the connection defaults (container name, host, port 2222, user/password,
VM directory) and the create recipe (delegating to the `windows-vm` skill's
documented dockur invocation). All overridable by env / flags so the runtime is
host-agnostic. Every SSH it issues disables `ControlMaster`.

### 2. Remote-host abstraction — `src/agents/windows-host.ts`

A thin, agent-neutral seam over `command-runner.ts` (the existing subprocess
seam, so tests inject fakes): connection config plus `ssh(cmd)`, `scpFrom(...)`,
`scpTo(...)`, `rsyncTo(...)`, all with mux disabled. This is the unit a future
non-Claude Windows agent reuses.

### 3. Windows Claude agent — config + context

- `coding-agents/claude-windows.yaml` — like `claude.yaml`, plus a `remote`
  block (host/port/user/password-source/Windows path roots) that marks the run
  as Windows and supplies the connection config. `session_log_dir` /
  `session_log_glob` keep pointing at the **local** post-capture paths, because
  the artifact layout is reproduced locally.
- `coding-agents/claude-windows-context/launch-agent` — a Linux bash launcher
  that `exec`s `ssh -tt` into the guest and runs Claude with the per-run Windows
  HOME, `ANTHROPIC_API_KEY`, `--dangerously-skip-permissions`,
  `--plugin-dir <win-superpowers>`, and `--model`. quorum substitutes the
  Windows paths and connection values into its `$…` placeholders, exactly like
  the Linux launcher.
- `coding-agents/claude-windows-context/HOWTO.md` — the Windows variant of the
  driving guide. Same "type one token, then watch the log" shape; the log path
  the QA agent tails is the **guest** path (the QA agent can `ssh` to peek), and
  the launch token is unchanged.

### 4. Windows provisioning adapter — `src/agents/claude-windows.ts`

A `CodingAgent` whose `provision()` performs step 2 over the remote-host seam and
returns the Windows-path substitutions the launcher and HOWTO need. It mirrors
`ClaudeAgent.provision`'s decisions (trust block, API-key approval, no
onboarding skeleton, no `IS_DEMO`) but writes them on the guest.

### 5. Capture-back runner seam

A single optional hook invoked after `invokeGauntlet` and before the post-run
snapshot, active only when the agent config carries a `remote` block. It scp's
the guest session logs + workdir into the local `<run>` paths. Kept narrow and
behind the config flag so the default (local) path is byte-for-byte unchanged.

### 6. Documentation

- This spec + the implementation plan.
- A terse operator section (in `README.md` or a `docs/windows/` note): bring the
  VM up, export connection env, run
  `quorum run scenarios/<name> --coding-agent claude-windows`, where results
  land, and the Linux+KVM-only constraint.

## Per-run isolation on Windows

Each run gets `C:\eval-runs\<runId>\{home,workdir}` and the launcher pins both
`HOME` and `USERPROFILE` to `…\home` so Claude's `.claude` is per-run. **To
verify during implementation:** that Windows Claude honors that override for its
config/transcript location (the launcher sets both env vars; if Claude only
respects one, the launcher is the single place to fix it). Cleanup deletes the
per-run tree after capture-back, matching the Linux model's disposability (the
shared `C:\eval-superpowers` cache persists).

## Credentials

`ANTHROPIC_API_KEY` is read through quorum's sanctioned env module and handed to
the guest by the launcher's `ssh` command for that session only — never written
into a tracked file, never the operator's OAuth. The trust block + API-key
approval suppress Claude's prompts headlessly, same as Linux. The guest's
existing OAuth login is ignored for evals.

`CLAUDE_CODE_FORCE_SESSION_PERSISTENCE=1` is set in the guest session so capture
stays robust; the Linux launcher's `env -u CLAUDECODE …` nested-session strip is
unnecessary here because the SSH session into Windows starts clean (the
launching Claude Code session's vars do not cross the SSH boundary).

## Non-goals

- No gauntlet changes. The tui adapter is used as-is.
- No harness execution inside Windows (no Bun/gauntlet/tmux in the guest).
- No `\\host.lan\Data` shared folder.
- No non-Claude agents in v1 (the seam is built for them; they are not wired).
- No macOS/Windows-Docker support; Linux+KVM only.
- No alternate verdict/results layout. The local layout is reproduced.
- No per-run VM snapshot/clone; isolation is a per-run directory.

## Risks to verify during implementation

These are explicitly unproven and must be checked, not assumed:

1. Windows Claude honors a per-run `HOME`/`USERPROFILE` override for `.claude`.
2. `--plugin-dir <win-path>` loads superpowers and `run-hook.cmd` hooks fire on
   Windows under `--dangerously-skip-permissions` (this is the product claim
   under test; a clean skill auto-trigger is the success signal).
3. The exact runner insertion point for capture-back relative to the
   pre/post session-log snapshot.
4. rsync availability/path-translation for the superpowers sync into Windows
   (Git Bash provides rsync/scp on the guest; the wrapper confirms it).

## Verification

Static gates (unchanged):

```bash
bun run check
bun run quorum check
```

Windows runtime gates (Linux+KVM host, trusted-maintainer only):

```bash
scripts/evals-windows-vm up
scripts/evals-windows-vm status
scripts/evals-windows-vm sync-superpowers
quorum run scenarios/sdd-go-fractals-opus48 --coding-agent claude-windows
quorum show
```

Success signals: a populated `<run>/home/.claude/projects/**` and
`<run>/coding-agent-workdir/**` captured from the guest; a real `verdict.json`;
and — for the acceptance scenario "Let's make a react todo list" — the
`brainstorming` skill auto-triggering, proving the superpowers bootstrap loaded
on Windows.

## Implementation phases

### Phase 1 — plumbing, no live eval

VM wrapper, remote-host seam, `claude-windows` config/context/launcher,
provisioning adapter, capture-back seam. Unit-test the wrapper arg/mount/mux
behavior and the launcher/HOWTO substitution contract through a fake
command-runner (no live VM), matching the `evals-container` test style.

### Phase 2 — live bring-up on a KVM host

Run `sdd-go-fractals-opus48` and the "react todo list" acceptance scenario
against `claude-windows` on `magic-kingdom`. Resolve the four verification risks.
Record the campaign in `docs/experiments/` per the experiment-log rule
(negative results at equal billing).

### Phase 3 — generalize the seam (deferred / desired)

Document what a second Windows agent (`codex-windows`) needs, to confirm the
remote-host + provisioning seam is genuinely agent-neutral. No second agent is
implemented in this slice.
