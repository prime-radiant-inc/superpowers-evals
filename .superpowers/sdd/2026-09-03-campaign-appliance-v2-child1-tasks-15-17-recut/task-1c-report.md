# Task 1c report

Status: DONE_WITH_CONCERNS

## Implementation

Orchestrator ruling (2026-09-03): Option 2 governs. The Task 1a fake-family
writer remains a plain `NAME=value` delivery file. The synthetic launcher
therefore uses the ruled exact protocol:

```sh
#!/bin/sh
exec env -i HOME="$HOME" PATH="$PATH" TERM="$TERM" \
  sh -c 'set -a; . "$QUORUM_SUBJECT_FILE"; set +a; exec "$QUORUM_AGENT_CWD/fake-coding-agent" "$@"' -- "$@"
```

This keeps export semantics with the sourcer, matching the established shared
stage-file convention, and keeps grader-related environment out of the fake
subject process.

Implemented the requested Steps 4 and 5 scope:

- Added `test/linux/fixtures/synthetic-checkout.ts`, which copies tracked
  repository files plus the explicitly whitelisted fake executable, excludes
  `node_modules`, `results`, and `.worktrees` from the copy, applies fixture
  configuration only in the temporary checkout, runs
  `bun run quorum check --update-manifests` there, and initializes a clean git
  commit after manifest generation.
- Added the executable
  `test/linux/fixtures/fake-coding-agent`. It records sorted subject-process
  environment evidence, writes a timestamped Claude JSONL tool-use row, emits
  the canned terminal protocol, and reads daemonization/hold behavior from a
  scenario setup file rather than Docker environment.
- Added `test/linux/campaign-attempt-docker.test.ts`. It is side-effect free at
  module load and gates every Docker operation behind Linux plus
  `QUORUM_DOCKER_INTEGRATION=1`. Each gated test creates its own synthetic
  checkout, provider, credential bundle, temporary live-spend lock, real
  `ContainerAttemptSpawner`, and cleanup path.
- The suite covers the nine required contracts: init/PID-1 and exit status;
  daemonized-child completion; graceful Docker stop and stopped evidence;
  SIGKILL evidence permissions; mount exclusion; parallel TMUX path and
  namespace separation; subject/grader environment isolation; provider header
  scope; and published run/journal/manifest evidence with credential-leak
  checks.

The copied campaign runtime is dynamically imported from the synthetic
checkout so its `repoRoot()` and results root point at the temporary fixture,
not this production checkout. Registration is invoked as a subprocess from
that copy, with the minimum child-contract ancestry check shimmed only for the
synthetic repository's intentionally new git history.

## Verification

Completed before the phase-boundary gate:

- `bunx biome ci` on the touched TypeScript files: pass.
- `bunx tsc --noEmit`: pass.
- `env -u QUORUM_DOCKER_INTEGRATION bun test test/linux/campaign-attempt-docker.test.ts test/agent-fake-family.test.ts test/fake-provider.test.ts`: 16 passed, 5 skipped, 0 failed.
- `sh -n test/linux/fixtures/fake-coding-agent`: pass.
- `git diff --check`: pass.

The Linux Docker tests were not executed on this macOS host. The required
appliance HOST-VERIFY step remains external to this checkout; no Docker
integration environment was enabled during implementation.

The final phase-boundary commands were run with the integration environment
unset:

- `env -u QUORUM_DOCKER_INTEGRATION bun run check`: failed after 402.86s with
  3,664 passed, 6 skipped, and 4 failed. The failures were the four
  `test/fake-provider.test.ts` cases that could not connect to their
  per-test provider sockets under the full-suite load. The new Linux suite
  was among the six skipped tests. The documented SIGINT failure condition
  did not occur, so no SIGINT isolation rerun was performed.
- `env -u QUORUM_DOCKER_INTEGRATION bun test test/fake-provider.test.ts`:
  6 passed, 0 failed in isolation. This confirms the full-gate failures are
  load-sensitive in the earlier Task 1b fixture tests, which this task did
  not modify.
- `env -u QUORUM_DOCKER_INTEGRATION bun run quorum check`: pass; all listed
  scenarios, credentials, and arms/suites validated.

The material concern is that the Docker suite remains structurally verified
and cleanly skipped on macOS, not runtime-verified here. It still requires
the Linux appliance HOST-VERIFY gate. The full repository gate also has the
four full-suite-only fake-provider socket failures described above.

## Commits

- `4a899ae7` — test: add task 1c synthetic fixture machinery
- `13e86530` — test: add Docker campaign attempt integration suite
- `2e01c72b` — docs: record task 1c implementation and ruling
- This report is finalized in the commit that contains this file.

## Fix round 1/5

### Ruling and per-finding changes

The orchestrator's Option 2 ruling remains in force: Task 1a's non-exporting
`NAME=value` writer is retained, and the synthetic launcher uses the exact
`env -i` / `set -a` protocol recorded in the Implementation section. This
round did not alter `test/linux/fixtures/fake-provider.ts` or the ruled
launcher shape.

1. The parallel-attempt assertion now preserves the complete Docker
   environment entry (`TMUX_TMPDIR=/run/quorum/attempt`) and compares that
   same representation, while still checking the shared path and separate
   backing mounts.
2. The credential scan now has an explicit target set: Docker inspection
   output, journal events and the journal database, job-record files, and
   captured stdout/stderr logs. It deliberately excludes the
   `subject-evidence/` subtree because the fake subject is required to write
   the credential-bearing environment evidence there. The SIGKILL assertion
   uses the same scoped scan.
3. Provider records are retained with `conversation_fingerprint` and `turn`,
   grouped by fingerprint, and checked for the expected independent
   `[1, 2, 3, 4]` sequence in each conversation. Header checks now assert
   credential containment: the grader credential is present only in the
   `x_api_key` value and the subject credential is absent from all provider
   headers.
4. Mount validation associates each inspected container with its
   `quorum.attempt_id` label and its own allowed attempt directory and staged
   credential/passwd/group sources. Any source under the campaign attempts
   root that is not in that container's own set, including a sibling attempt
   directory or stage file, is rejected.
5. Cleanup now attempts every exact captured container ID, provider shutdown,
   synthetic-checkout cleanup, and temporary-tree cleanup even after an
   individual operation fails, aggregating cleanup errors rather than
   short-circuiting. The async run helpers also clean up when the run rejects,
   and combine run and cleanup failures. Stop, SIGKILL, and parallel tests all
   use this path.
6. `test/fake-provider.test.ts` now has bounded connection-establishment
   tolerance only: SDK and fallback-fetch connections retry recognized
   loopback startup errors for 20 attempts at 250 ms, with a 10-second test
   timeout. The test-side connection helper also queues a loopback proxy
   bypass (`NO_PROXY` and `no_proxy` for `127.0.0.1`, `localhost`, and `::1`)
   so ambient proxy settings cannot intercept local provider sockets. A
   regression test covers that bypass. The provider fixture itself was not
   changed.

### Verification

The retry change was developed test-first. Before the proxy-bypass helper was
implemented, the new loopback regression test failed (0 passed, 1 failed)
because the local-host bypass entries were absent. After the implementation:

- `env -u QUORUM_DOCKER_INTEGRATION bun test test/fake-provider.test.ts`:
  8 passed, 0 failed.
- `env -u QUORUM_DOCKER_INTEGRATION -u NO_PROXY -u no_proxy HTTP_PROXY=http://leak bun test test/fake-provider.test.ts`:
  8 passed, 0 failed. This exercises the ambient-proxy failure mode.
- `env -u QUORUM_DOCKER_INTEGRATION bun test test/linux/campaign-attempt-docker.test.ts`:
  0 passed, 5 skipped, 0 failed.
- `bunx biome ci test/fake-provider.test.ts test/linux/campaign-attempt-docker.test.ts`:
  pass.
- `bunx tsc --noEmit`: pass.
- `env -u QUORUM_DOCKER_INTEGRATION bun run quorum check`: pass; all
  scenarios, credentials, and arms/suites validated.
- `git diff --check`: pass.

The first exact post-fix phase-boundary run of
`env -u QUORUM_DOCKER_INTEGRATION bun run check` passed the fake-provider
suite but had one unrelated full-suite timeout in
`test/cli-run-superpowers.test.ts` (`--superpowers-root: provenance reads the
threaded root, not ambient`), with 3,669 passed, 6 skipped, and 1 failed.
The exact test passed in isolation (1 passed, 12 filtered, about 3.69 s).
The required exact rerun then passed:

- `env -u QUORUM_DOCKER_INTEGRATION bun run check`: 3,670 passed, 6 skipped,
  0 failed across 247 files; the dashboard gate also passed with 144 passed,
  0 failed.
- The full gate included all known SIGINT tests, and they passed; the
  documented SIGINT isolation rerun was therefore not needed.
- The Linux Docker suite reported five clean skips with the integration
  environment unset. Docker runtime and appliance HOST-VERIFY remain external
  evidence on this macOS host.

### Fix commits

- `6807b176` — test: tolerate transient fake-provider startup
- `170cbedd` — test: close task 1c review findings
- `232f8cf2` — test: broaden fake-provider startup retry
- `b6c061f9` — test: extend fake-provider readiness window
- `111e4b8e` — test: widen fake-provider startup tolerance
- `abf2ff42` — test: harden fake-provider loopback connections

## Fix round 2/5

### Failure evidence and root cause

The first real Linux run exposed the fixture-construction failure described in
the review: all five tests stopped at synthetic checkout registration because
the generated `checks.sh` used one-line `pre() { :; }` and `post() { :; }`
declarations. The manifest extractor rejected line 1 because its declaration
must end at `{` and its function body must continue on later lines.

After that format was corrected, the first Linux retry stopped at registration
for a second, test-owned reason. The registration subprocess reported that the
synthetic evals commit predated the minimum child-contract commit. Diagnostics
showed `git lookup: /usr/bin/git (status 0); shim mode 755`. The fixture used
`node:path`'s filesystem `sep` (`/`) when constructing the PATH list, so the
temporary git shim was not a PATH entry. This was verified with an exec trace:
the child-contract probe executed `/usr/bin/git` directly.

### Changes

- `campaign-attempt-docker.test.ts` now writes manifest-compatible multi-line
  functions:
  `pre() {`, `file-exists fake-coding-agent`, `}`, followed by
  `post() {`, `file-exists subject-ran.txt`, `}`. These are the plan's two
  minimal behavioral checks, using the bare-verb DSL.
- `fake-coding-agent` now writes the non-secret `fake subject ran` marker to
  `subject-ran.txt` in its current workdir, allowing the post-check to prove
  the subject ran.
- The registration failure now reports subprocess status, stdout, stderr,
  the effective `git` lookup, and shim mode. This exposed the Linux-only test
  harness defect without changing registration behavior.
- The test now uses `path.delimiter` for the PATH shim while retaining
  `path.sep` for filesystem-prefix comparisons.

### Local verification

- A direct `createSyntheticCheckout` reproduction, with no Docker integration
  environment, failed with the exact manifest-extractor error for
  `pre() { :; }`.
- The corrected synthetic checkout passed
  `bun run quorum check --update-manifests`; its generated manifest contains
  exactly the pre `file-exists fake-coding-agent` and post
  `file-exists subject-ran.txt` entries.
- The fake agent marker regression changed from `subject-ran.txt is absent` to
  `subject-ran.txt present` after the fixture change.
- `env -u QUORUM_DOCKER_INTEGRATION bun test test/linux/campaign-attempt-docker.test.ts`:
  0 passed, 5 skipped, 0 failed.
- `bunx biome ci test/linux/campaign-attempt-docker.test.ts` and
  `bunx tsc --noEmit`: pass.
- `env -u QUORUM_DOCKER_INTEGRATION bun run quorum check`: pass; all
  scenarios, credentials, and arms/suites validated.
- `git diff --check`: pass.

### Devbox verification

The devbox was updated to each pushed commit with `git fetch origin` and
`git reset --hard origin/drew/child1-tasks-15-17-recut`.

- At `a76c07db`, the single gated test failed at registration with the
  child-contract diagnostic and effective lookup `/usr/bin/git`.
- At `a1499ad3`, the single gated test crossed registration and executed real
  containers. It then failed at container inspection because the container
  exited 1; campaign output reported `attempt staging must hold exactly one
  run directory, found []`, `capture_failed`, and an accounting gap with no
  readable actual cost.
- The exact requested command
  `GAUNTLET_ROOT=$HOME/prime-rad/gauntlet SUPERPOWERS_ROOT=$HOME/prime-rad/superpowers QUORUM_DOCKER_INTEGRATION=1 bun test test/linux/`
  completed in 16.43 seconds with 1 passed, 4 failed, 30 expectations. The
  SIGKILL evidence test passed; the complete, daemonized, stop, and parallel
  tests failed, with the stop and parallel tests also reaching their 5-second
  test timeouts. All five tests constructed fixtures and reached real campaign
  registration/container execution before those runtime failures.

No runtime capture/staging behavior was changed in this round. The remaining
`attempt staging must hold exactly one run directory` / `capture_failed`
failure is the next integration boundary to investigate, not a fixture-format
fix to guess at.

### Round commits

- `c65ac830` — test: make fake campaign checks executable
- `a76c07db` — test: expose synthetic registration diagnostics
- `10de15e2` — test: diagnose Linux registration PATH
- `a1499ad3` — test: use PATH delimiter for Linux fixture shim

## Fix round 3/5

### Failure evidence and root cause

The first round-3 devbox run was made against `ada4e38c`, with the requested
Docker integration environment enabled. Its retained attempt stderr identified
the early exit that the campaign report had hidden:
`error: bun is unable to write files to tempdir: AccessDenied`. The container
configuration showed that the synthetic checkout's `node_modules` was an
absolute symlink back to the devbox source checkout. That source path was not
inside the only evals tree bind-mounted into the attempt container, so the
container had no dependencies. Bun fell back toward the image install location,
which is not writable by the attempt UID. This was a fixture-boundary defect;
the Child 1 spawner and entrypoint were not changed.

After materializing dependencies in the synthetic copy, the next devbox run
crossed that boundary. It created and started real attempt containers, emitted
`run_allocated`, and produced Gauntlet `run.jsonl` files with an
`llm_request` event. The provider record remained empty and the complete test
eventually hit its explicit 180-second timeout because the grader could not
reach the host fake provider.

The reachability check used the runtime-resolved Docker bridge gateway:
`docker network inspect bridge` reported subnet `172.17.0.0/16` and gateway
`172.17.0.1`; the host fake provider was listening on `0.0.0.0:<port>` and
host loopback/bridge curls returned HTTP 404 (the provider's expected response
to a non-POST route). Docker containers using both UID 1001 and root timed out
connecting to `http://172.17.0.1:<port>/v1/messages`, while a host-network
container returned 404. Read-only firewall inspection showed active UFW with
default-deny INPUT and no `docker0` allow rule. The suite's gateway parsing and
provider bind are therefore correct; the devbox host policy blocks bridge to
host connections.

### Changes

- `campaign-attempt-docker.test.ts` now snapshots retained attempt
  `stdout.log`/`stderr.log` files and any files under the run's
  `gauntlet-agent/results` tree into the fixture temp directory before
  teardown. It appends bounded tails to assertion failures, and a failure in
  the diagnostic collector itself is rendered without bypassing cleanup. On
  an early campaign failure it also enumerates campaign-labeled retained
  containers into the exact-ID cleanup set before teardown; Docker enumeration
  failures are surfaced while provider and filesystem cleanup still runs.
- All five gated integration tests now use an explicit `180_000` ms timeout.
- `synthetic-checkout.ts` removes the local-only absolute `node_modules` link
  and runs `bun install --frozen-lockfile` in the synthetic copy. The generated
  dependency tree remains ignored and outside the committed fixture tree, but
  is visible through the evals bind mount exactly as the production snapshot's
  install is.
- No production Child 1 behavior or host firewall state was changed.

### Verification

Local verification after the fixture and diagnostic changes:

- `bun test test/linux/campaign-attempt-docker.test.ts`: 0 passed, 5 skipped,
  0 failed with the integration environment unset.
- `bun test test/fake-provider.test.ts`: 8 passed, 0 failed.
- `bunx biome ci test/linux/fixtures/synthetic-checkout.ts test/linux/campaign-attempt-docker.test.ts`:
  pass.
- `bunx tsc --noEmit`: pass.
- `bun run quorum check`: pass.
- `git diff --check`: pass.
- A direct synthetic-checkout construction with a minimal valid temporary
  fixture passed and confirmed `node_modules` was a real directory, not an
  external symlink.

Devbox verification:

- At `ada4e38c`, the requested full Linux command reached real containers but
  reported 1 pass and 4 failures in 189.83 seconds. The diagnostics showed
  `AccessDenied` in every failing attempt's stderr.
- At `80ad2f27`, registration succeeded and the suite reached the real
  container/Gauntlet path. The complete test timed out at 180 seconds while
  waiting for provider progress; its retained attempt logs contained
  `run_allocated` and empty stderr, and the staging run contained Gauntlet
  `run.jsonl` but no provider record. The run was stopped after this evidence
  was collected rather than changing the suite to evade the bridge contract.
- The retained attempt containers and synthetic/debug trees from the interrupted
  diagnostic runs were removed by exact resolved paths; a final devbox check
  reported zero `quorum-attempt` containers and no matching test temp trees.

### Round commits

- `ada4e38c` — test: preserve Linux campaign failure diagnostics
- `80ad2f27` — test: materialize synthetic checkout dependencies
- `b2615d69` — test: finish Linux runtime-boundary diagnostics
- `5d4cbb7c` — test: clean retained containers after early failure
