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
