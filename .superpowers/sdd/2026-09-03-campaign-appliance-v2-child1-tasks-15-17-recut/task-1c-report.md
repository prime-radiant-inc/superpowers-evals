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
