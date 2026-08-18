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
installed wrapper uses the embedded host config path, normally
`/srv/quorum/config/appliance.json`, verifies the evals checkout is clean and on
the configured branch, then exports that path to the repo-owned TypeScript CLI.
Direct local `bun run appliance ...` use can still set `EVALS_APPLIANCE_CONFIG`
when intentionally running outside the installed wrapper.

## Operator Rule

Agents operating shared live evals use the appliance helper, not raw quorum
commands. The helper owns repo sync, ref resolution, blessed-bundle mounting,
preflight, locks, job records, logs, provenance, and cancellation.

Live eval artifacts are sensitive. Do not paste raw transcripts, run homes,
tool-call logs, or credential-bearing files. Prefer `status`, `show`, `costs`,
and reviewed summaries.

## Access Boundary

Routine appliance operation uses the approved private access path documented in
the private ops runbook. Provider-specific break-glass access is for recovery
only when the normal private path is unavailable; if it is used, record why.

Do not add real hostnames, account identifiers, access-provider commands, or
secret parameter names to this public runbook.

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
     --coding-agents claude,codex,kimi \
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

## Importing Locally-Run Results

Runs produced on a workstation before the appliance existed are moved in two
steps: a local export that scrubs them, and an appliance-side import that
ingests the result. Never copy a raw local `results/` tree to the shared box —
run homes contain live agent credentials.

Design:
[`docs/superpowers/specs/2026-08-09-appliance-results-import-design.md`](superpowers/specs/2026-08-09-appliance-results-import-design.md).

### Step 1: Export locally

On the workstation that holds the runs:

```bash
bun run quorum export-runs <results-dir> \
  --out <bundle-dir> \
  --superpowers-repo <path-to-superpowers-checkout>
```

This copies an allowlist — `verdict.json`, `trajectory.json`,
`coding-agent-token-usage.json`, `phase.json`, `gauntlet-agent/`,
`coding-agent-workdir/`, and the raw session logs lifted to `raw-sessions/` —
and drops each run's throwaway `$HOME` wholesale. `auth.json`,
`credentials.snapshot.yaml`, and agent config files never enter the bundle.

`--superpowers-repo` lets the export resolve the skill tree a run archived back
to an exact commit. Without it, runs whose verdict lacks a rev degrade to
`tree_only`: the tree hash is still recorded, but no commit is named. It
defaults to `$SUPERPOWERS_ROOT`.

The summary line reports how each run's superpowers rev was established:

```
bundle written to /tmp/lane-b-bundle
  exported 346, skipped 0
  superpowers rev: recorded=196 recovered=128 inferred=22
```

`recorded` came from the verdict, `recovered` was matched exactly from the
archived tree, `tree_only` means the run used a modified tree that matches no
commit, `inferred` was borrowed from the nearest co-temporal run in the same
experiment directory and is stored in its own field, and `unknown` means no
evidence survived.

### Step 2: Verify before transfer

The bundle is meant to be audited before it crosses to a shared host. Confirm
it carries no credentials:

```bash
find <bundle-dir> \( -name auth.json -o -name 'credentials.snapshot.yaml' \
  -o -name 'config.toml' -o -name '.env*' -o -name '*.pem' -o -name '*.key' \) | head
```

Expect no output. Then transfer the bundle over the approved private access
path documented in the private ops runbook.

### Step 3: Import on the appliance

```bash
evals-appliance import --json <bundle-dir>
```

Import verifies every checksum in the manifest and re-runs the credential
denylist against what is actually on disk before anything lands, so a tampered
or mis-built bundle is rejected whole. It holds `run.lock` for the duration; if
a live job holds it, import returns `lock_busy` and does nothing. Each run then
lands by staging the payload beside the results root and atomically renaming it
into place — import never modifies or deletes a landed run directory.
Re-running is safe: a run whose landed content already matches the bundle is
skipped, and if the run dir predates appliance job records — or a previous
recording was left incomplete — the record is healed in `state/` only (never
by writing inside the landed run) so `status`/`show` see it. If the landed run
differs from the bundle, that
entry is rejected as `import_conflict`: the landed run stays byte-for-byte
untouched and the incoming payload is moved to `state/quarantine/` for
comparison. An entry whose `run_id` equals an unrelated job's id is rejected
(`config_invalid`) so `status`/`show` stay unambiguous, and corrupt job
records under `state/jobs` fail entries closed for manual repair. Per-entry
failures are reported with `run_id`, code, and message in the JSON result; a
failed entry never leaves a job record claiming success — its record stays
visibly incomplete for the next import to reuse. There is no `--force`: if a
landed run is wrong, move the bad directory aside yourself after inspection
and re-import.

Imported runs are visible to the normal read commands:

```bash
evals-appliance status --json <run-id>
evals-appliance show <run-id>
evals-appliance costs <run-id>
```

An imported job reports `kind: "import"` and carries an `origin` block instead
of `refs` and a credential bundle, because it was neither built from an
appliance-resolved ref nor run against the blessed bundle. Treat
`origin.rev_recovery` as the confidence marker: `inferred_superpowers_sha` is a
neighbour's sha, not evidence about the run itself.

## Pruning Incomplete Run Dirs

Interrupted or abandoned runs leave directories with no `verdict.json` that
nothing can read — the dashboard and `quorum show` both ignore them. Prune
quarantines them:

```bash
evals-appliance prune --json                 # dry-run report (default)
evals-appliance prune --apply --json         # move candidates to state/quarantine/
evals-appliance prune --apply --older-than-days 14
```

A directory is a candidate only when ALL of these hold: it sits directly under
the results root, it has no `verdict.json` (completed runs are never pruned —
their retention waits for an explicit archive/retention contract), its mtime is
older than the age floor (`--older-than-days` accepts only a positive integer;
default 7 days), and nothing references it — no batch `results.jsonl` record,
no appliance job record, and no mention anywhere under `campaigns/` (a
fail-closed substring scan, so campaign-referenced runs stay protected as the
campaign kernel lands). Stale import stage dirs — exactly the
`.importing-<run-id>.<pid>.tmp` slots a crashed import leaves, under the same
reference protection — are candidates too; anything merely resembling that
name is treated as an ordinary run dir. Reference state that cannot be read
honestly makes prune refuse to plan at all (`config_invalid`) rather than
guess: a batch dir without a canonical `batch.json`, an unparseable or
non-canonical `results.jsonl` record, a corrupt job record under
`state/jobs`, any symlink inside the batches, jobs, or campaigns namespaces,
or a results root that is not itself a real directory. Repair the state and
rerun.

`--apply` holds `run.lock` (it refuses with `lock_busy` while a batch or import
is live) and **moves** candidates to `state/quarantine/` — it never deletes.
If any candidate cannot be moved, the command reports the partial result
(`quarantined` and `failures` both listed) with `ok: false` and a nonzero
exit; the failed sources stay where they were. Inspect quarantined dirs
there; restore one by moving it back. Final deletion of a quarantined
directory is a manual operator decision, after inspection, with `rm -rf`
typed by a human who has looked at it.

## Dashboard

The dashboard is read-only and must not submit or stop jobs:

```bash
bun run dashboard --results results --manifest results/grid-manifest.json
```

On the shared box, bind it only to loopback or the approved private network.
Use the private ops runbook for operator access and forwarding details.

## Break-Glass

Raw commands are for local development or trusted-maintainer break-glass only:

```bash
scripts/evals-container exec quorum run-all ...
bun run quorum run ...
```

Before using break-glass on the shared box, verify no live job holds `run.lock`,
record why the helper could not be used, and run `doctor --json` afterwards.
