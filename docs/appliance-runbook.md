# Shared Eval Appliance Runbook

This is the agent-facing runbook for the Phase 1 shared quorum appliance. The
design lives in
[`docs/superpowers/specs/2026-06-18-shared-eval-appliance-design.md`](superpowers/specs/2026-06-18-shared-eval-appliance-design.md).

The installed `evals-appliance` helper described here is the target Phase 1
interface. Until that helper exists on a configured appliance, raw local
`bun run quorum ...` and `scripts/evals-container exec quorum ...` commands are
local or break-glass workflows only.

## Install And Bootstrap

Install the host wrapper from the trusted evals checkout:

```bash
scripts/install-evals-appliance /srv/quorum
```

The installer writes `/srv/quorum/bin/evals-appliance` and prints that path. It
does not write `appliance.json`, create credentials, or mutate repositories. The
installed wrapper reads `EVALS_APPLIANCE_CONFIG` or
`/srv/quorum/config/appliance.json`, verifies the evals checkout is clean and on
the configured branch, then dispatches to the repo-owned TypeScript CLI.

## Operator Rule

Agents operating shared live evals use the appliance helper, not raw quorum
commands. The helper owns repo sync, ref resolution, blessed-bundle mounting,
preflight, locks, job records, logs, provenance, and cancellation.

Live eval artifacts are sensitive. Do not paste raw transcripts, run homes,
tool-call logs, or credential-bearing files. Prefer `status`, `show`, `costs`,
and reviewed summaries.

## Before Launch

Start with a read-only health check. `doctor` must not fetch, checkout, build,
start containers, source credentials, remove locks, or mutate job records:

```bash
evals-appliance doctor --json
```

Prepare the exact Superpowers ref to test:

```bash
evals-appliance prepare --json --superpowers-ref <branch-tag-or-sha>
```

The helper must resolve mutable refs to exact SHAs. If `prepare` returns
`lock_busy` during an active live job, dirty checkout, ambiguous ref, stale
lock, missing credential bundle, or failed container preflight, stop and report
that result instead of guessing. `prepare` must not change refs underneath an
active live eval.

Phase 1 shared `run-all` is Linux-container-only. Windows evals and Antigravity
remain trusted-maintainer break-glass paths until the appliance explicitly
supports them.

## Sentinel Batch

Start with the sentinel tier and a narrow target set:

```bash
evals-appliance run-all --json --detach \
  --superpowers-ref <branch-tag-or-sha> \
  -- --tier sentinel \
     --coding-agents claude,claude-haiku,claude-sonnet,codex,kimi \
     --jobs 4
```

For fragile or single-column targets:

```bash
evals-appliance run-all --json --detach \
  --superpowers-ref <branch-tag-or-sha> \
  -- --tier sentinel \
     --coding-agents gemini \
     --jobs 1
```

The first JSON response should contain a `job_id`. Record that id in your work
notes; it is the recovery handle if the SSH session drops.

## Single Scenario

Use a single-scenario run for a focused RED/GREEN check:

```bash
evals-appliance run --json --detach \
  --superpowers-ref <branch-tag-or-sha> \
  --scenario scenarios/<name> \
  --coding-agent <agent>
```

Use `--detach` by default unless you are deliberately doing a short foreground
smoke and can tolerate the shell owning the lifetime.

## Status, Show, Costs

Recover or poll a job:

```bash
evals-appliance status --json <job-id>
```

Inspect summarized results:

```bash
evals-appliance show --json <job-id>
evals-appliance show <job-id>
evals-appliance costs --json <job-id>
evals-appliance costs <job-id>
```

If a batch id is known, the helper may accept it directly. Raw
`scripts/evals-container exec quorum show/costs ...` remains a local or
break-glass read path because the container's `quorum` shim may source the live
credential env.

The helper's status should distinguish appliance failure from eval failure. A
completed batch with failing cells is a completed job with a failing summary, not
an appliance crash.

## Cancel

Cancel through the job record:

```bash
evals-appliance cancel --json <job-id>
```

The helper sends SIGINT to the tracked process group and waits for stopped
verdicts or a batch footer. If cancellation returns `lost`, do not retry a new
live job until `doctor --json` explains the lock and process state.

## Dashboard

The dashboard is read-only and must not submit or stop jobs:

```bash
bun run dashboard --results results --manifest grid-manifest.json
```

On the shared box, bind it only to loopback or a tailnet address, and prefer
SSM/Tailscale forwarding over public exposure.

## Break-Glass

Raw commands are for local development or trusted-maintainer break-glass only:

```bash
scripts/evals-container exec quorum run-all ...
bun run quorum run ...
```

Before using break-glass on the shared box, verify no live job holds `run.lock`,
record why the helper could not be used, and run `doctor --json` afterwards.
