# Gauntlet-owned termination proof for observer finalization

Date: September 5, 2026. Tracking: PRI-3097.
Status: proposed architectural choice; not yet approved for implementation.

## Decision requested

Use a Linux-only, Gauntlet-owned child-subreaper supervisor around the entire
Gauntlet invocation. Implement the helper in Python 3 standard library, using
Linux `prctl` through `ctypes` and direct `fork`, `execve`, and `waitpid` calls.
Evals remains outside the supervised ancestry and can freeze evidence after the
supervisor has drained it. This requires no new container privilege or delegated
cgroup. Python/kernel availability and actual image behavior require qualification.

This extends the approved PR2258 design's termination requirement with a concrete
cross-repository runtime mechanism. It does not enable Claude, change the outer
campaign deadline, authorize installation, or authorize provider calls.

## Why this boundary

Current Gauntlet `src/runtime/process-tree.ts` converts process enumeration errors
into an empty list. `src/adapters/tui/adapter.ts` snapshots bare PIDs and does not
prove final absence. `src/runs/orchestrator.ts` writes its result before cleanup
and swallows cleanup errors. Grader shell-tool processes also exist outside the
TUI process ancestry. An exit code, stable transcript reads, or a JSON receipt
around these existing operations cannot prove subject termination.

The supervisor must precede the first Gauntlet exec. Its ancestry then includes
Gauntlet, its private tmux daemon, the Coding-Agent, delegated local processes,
and grader shell tools. Supervising only the TUI would omit the last category.
The existing campaign container remains the separate outer containment boundary
for controller loss, deadline enforcement, and terminal acceptance.

## Considered approaches

| Approach | Assessment |
| --- | --- |
| Add start times to current PID snapshots | Cannot recover children reparented before the snapshot; insufficient proof. |
| Delegate a cgroup per Gauntlet invocation | Strong containment, but adds host/container privilege and provisioning requirements. |
| Whole-invocation child subreaper | Recommended: owns orphan adoption and wait semantics within the existing worker container. |

## Ownership and completion

The single-threaded supervisor sets `PR_SET_CHILD_SUBREAPER` before it forks.
It owns all waits and keeps SIGCHLD at its default disposition without
`SA_NOCLDWAIT`. Double-forking and changing session/process group do not remove
ancestor subreaper adoption. Nested subreapers must themselves be drained.

At normal Gauntlet exit, error exit, stop, or loss of the Evals control channel,
the helper enters teardown. It forwards graceful stop to its exact unreaped
Gauntlet child where applicable, then repeatedly enumerates its direct children,
signals them, and reaps them. No reaping occurs between direct-child enumeration
and signaling: a retained child identity cannot be recycled into an unrelated
process during that interval. Enumeration errors, malformed process identities,
unexpected signaling errors, and unexpected wait errors remain explicit failures.

Success requires the kernel's `ECHILD` response from
`waitpid(-1, WNOHANG | __WALL)`, after teardown. An empty `/proc` listing or a
`waitpid` return of zero is not success. `__WALL` includes clone children omitted
by ordinary waiting. PID, process-start ticks, boot identity and PID-namespace
identity are recorded as provenance; ancestry and sole-reaper ownership establish
the live signaling authority.

This proof covers freshly launched local processes. Attaching to a pre-existing
external daemon, privileged process migration, and deliberate same-UID tampering
are outside it and cannot be presented as covered. The subject and observer are
cooperating components, as stated in the parent spec.

## Evals integration contract

Launch the snapshot-pinned `gauntlet-supervise` with the existing exact Gauntlet
executable/arguments. Preserve stdout/stderr logging separately from protocol.
Use two private inherited descriptors between Evals and the supervisor: a control
pipe and a proof pipe. Close both in the Gauntlet child before exec so its
processes cannot retain or write the protocol handles. Use `/dev/null` for the
Gauntlet child's unused stdin. Do not wait indefinitely for logging pipes held
by surviving descendants.

The initial control message binds a new invocation nonce to the existing
run/attempt binding digest. A successful receipt repeats that binding, identifies
the supervisor implementation and process, records the actual Gauntlet child's
exit code/signal separately from the helper's exit, names the teardown trigger,
and carries the successful kernel-wait observation. Only the original private
proof channel can deliver it. A receipt found on disk afterward is not proof of
this invocation. Missing, partial, duplicate, contradictory or wrong-binding
messages make the observer evidence unusable.

Extend Evals `InvokeGauntletResult` with a closed termination outcome. Runner
finalization waits for supervisor settlement before its terminal document and
transcript snapshots; it does not infer termination from Gauntlet's result JSON.
Persist the validated receipt into ordinary frozen evidence for manifest and
publication authentication. Post-checks consume the frozen bundle only.

The existing five-second outer hard-kill grace remains fixed. Teardown uses a
single bounded deadline and reserves time within that horizon for reaping and
finalization; repeated signals cannot reset it. It adds no second grace period.
On a hard kill or helper failure before proof, there is no usable observer bundle.
The outer campaign's container-stop proof cannot retroactively manufacture one.

## Evidence required before activation

Local macOS tests cover the protocol parser, nonce/binding validation, runner
ordering on normal/error/stop paths, partial receipts, bounded waits and explicit
missingness using an injected supervisor. They do not qualify Linux ownership.

Linux tests must run the actual helper with non-provider fixture programs:

- Double-forked and setsid descendants, including children reparented before stop.
- Nested subreapers and descendants forking during graceful shutdown.
- Ordinary and clone children, including the wait modes that require `__WALL`.
- A graceful final write before proof, and an INT/HUP-immune writer requiring kill.
- Initial Gauntlet exit, crash, guard failure, stop and control-channel EOF.
- Failed enumeration/signaling/wait, helper crash and forced kill: never success.
- Inherited log handles do not keep Evals blocked after the bounded shutdown.
- Six concurrent supervisors kill/reap only their own process trees.
- Real private-TUI and shared shell-tool launches inherit the supervisor.

Inject syscall outcomes for PID reuse invariants; do not rely on recycling real
host PIDs. Verify exact Python/kernel/image availability before installed use.
No paid qualification follows automatically from these source tests.

## References and source boundary

Parent: [PR2258 parallel comparison design](2026-09-05-pr2258-parallel-comparison-design.md).
Inspected Gauntlet revision: `588a81e80fe3cd7b7d3bc2c7f4207bed4ecb14df`.
The existing Gauntlet checkout has unrelated untracked files; implementation, if
approved, will use a separate worktree.

Linux documents orphan adoption in
[PR_SET_CHILD_SUBREAPER](https://man7.org/linux/man-pages/man2/PR_SET_CHILD_SUBREAPER.2const.html)
and clone/SIGCHLD wait behavior in
[waitpid](https://man7.org/linux/man-pages/man2/waitpid.2.html).
These semantics support the design; only the actual Linux tests qualify its
implementation and boundary assumptions.
