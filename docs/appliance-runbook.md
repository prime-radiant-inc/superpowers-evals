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

## Credential Scoping

A live appliance job delivers exactly one agent's credentials, and nothing
else. `run` takes `--coding-agent <agent>` with an optional
`--credential <name>`; `run-all` takes `--coding-agents` with exactly one entry
and an optional `--credentials` with exactly one name. An omitted credential
means that agent's registry default. A list, a blank value, or a value that
looks like an option is refused at argument validation, before any job record
exists, and so is a repeated *credential or run-all selection* flag:
`run --credential`, `run-all --coding-agents`, and `run-all --credentials` each
refuse a second occurrence instead of letting one silently win. Pass
`run --coding-agent` once — it is an ordinary required option, so a repeat
resolves last-win rather than being refused. Mixed-scope batches are rejected
and stay rejected until per-cell containers land. `run-all` also refuses
`--coding-agents-dir`, `--out-root`, `--scenarios-root`, `--credentials-file`,
and `--credential`: the first three would relocate the trusted roots the
appliance controls, `--credentials-file` would swap the blessed registry the
bundle was built for, and `--credential` is `run`'s flag, which would leave the
real selection unmade while looking like it had been made.

That one `(agent, credential)` cell is resolved at submission against the evals
corpus at its current commit and written into the job record once, as an
immutable triple: the selection, the resolved scope, and the source evals SHA.
Nothing later in the job's life may patch that authority.

### What the container receives

The scoped container gets one read-only bind of the generation's `agent.env` at
`/run/evals/credentials.env`, carrying only the env names this cell's scope
projects (plus `GEMINI_AUTH_TYPE` when the scope pins a Gemini mode), and at
most one read-only bind of one projected OAuth directory at its fixed
destination: `/auth/codex`, `/auth/gemini`, `/auth/kimi-code`, or `/auth/pi`.

Those projections are exact files, never whole source directories. Codex gets
`auth.json` only. Gemini gets `oauth_creds.json` and `google_accounts.json`.
Kimi gets `config.toml` and `credentials/kimi-code.json`, plus
`oauth/kimi-code` when the bundle carries it. Pi gets `agent/auth.json`
rewritten down to the single selected provider entry; `settings.json` is never
projected. The Antigravity projector delivers
`antigravity-cli/antigravity-oauth-token` only — never the Gemini personal
files, and vice versa, even though both share the `gemini` mount name — but
the appliance still refuses to submit an Antigravity job at argument
validation, so that path is reachable only by trusted-maintainer break-glass.

`supervisor.exec.env` is never mounted anywhere. It reaches exactly one
process — the live Quorum supervisor — as the host-side argument of
`docker exec --env-file`. The grader credential travels in that file only
under its `QUORUM_GRADER_*` alias names, and the runner maps those aliases
back onto the canonical names — `CLAUDE_CODE_OAUTH_TOKEN`,
`ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_API_KEY`, and `ANTHROPIC_BASE_URL` — when
it builds the Gauntlet child's environment. The alias names never reach that
child, and the canonical names never appear in the supervisor exec file.

The invariant is about **values, not names**. The grader's secret values are
absent from `agent.env`, absent from every projected auth file, and never
intentionally delivered to a Coding-Agent. They exist in `supervisor.exec.env`
under the alias names, and in the Gauntlet child's environment under the
canonical names, which is where the grader CLI reads them.

A canonical name can legitimately appear on the agent side at the same time,
carrying an entirely different secret. A Claude or Serf api-key credential
projects `ANTHROPIC_API_KEY` into `agent.env`, and a Claude OAuth credential
projects `CLAUDE_CODE_OAUTH_TOKEN` — in both cases that is the selected
agent's own credential, mounted at `/run/evals/credentials.env` exactly as
intended. Same name with a different value is permitted **only** because
staging proves the values differ: every secret delivered to the agent is
compared all-pairs against every nonempty grader auth value, and any equality
refuses the job (see
[Bundle migration and rollback](#bundle-migration-and-rollback)). So a shared
variable name is not evidence of a leak, and it is not licence to reuse one
key for both roles — that is the case the check exists to refuse.

No Coding-Agent is handed those values: each launcher rebuilds the agent's
environment with `env -i` and an explicit allowlist fed from that run's own
credential file, so nothing is inherited from Gauntlet even though the
launcher starts as its child. That is an **intentional-delivery** boundary,
not a containment one. A Coding-Agent runs
at the same privilege as the Gauntlet child, so an agent that goes looking can
still read the grader's values out of a peer process; see
[Isolation boundary and accepted residual](#isolation-boundary-and-accepted-residual).

If the bundle provides no nonempty source for a projected env name or a
required OAuth file, the whole job is refused before live execution. The
refusal names the destination and its candidate source names, or the bundle
path, and never a value.

### Preflight, and the lease the worker is bound to

Preflight syncs the managed repos and resolves the requested Superpowers ref,
then re-verifies the job's persisted source SHA against the fast-forwarded
evals checkout **and** recomputes the scope from that corpus; either mismatch
refuses before Docker. It then requires `docker exec --env-file`, builds, and
recreates the container around an **asserted-empty** generation to run
`evals-tool-versions` and `quorum check` — no credential material exists at
any point in that probe. Only then is the probe container downed, the live
generation staged, and the container recreated around exactly the projected
material.

The container ID is captured from `docker run` stdout and verified by direct
inspection of that exact ID; a name lookup is never blessed as the lease
identity. That inspection also verifies the container's **actual** mount
topology: exactly one read-only bind of the generation's `agent.env` at
`/run/evals/credentials.env` and exactly one read-only bind of each asserted
projection at its fixed destination, then a sweep of every remaining mount
which rejects `/auth` itself and every unasserted `/auth` descendant (compared
component-wise, so a path like `/authority` is not caught by accident); any
source that is, sits inside, or contains the blessed bundle directory; any
source touching the scoped credential state namespace other than the exact
asserted projections; and any source that is or contains
`supervisor.exec.env`. A rejection removes exactly the captured container ID —
never the configured name — and fails the job typed.

Immediately before the live exec the worker rereads the job record and rebinds
it to the lease preflight attested: the record's authoritative scope must
canonically equal the lease's, and its recorded container evidence must be
exactly what that lease produces. A record re-pointed at another cell between
preflight and execution is refused typed, with no live exec and no supervisor
env file attached to anything.

Liveness and cancellation target the recorded immutable container ID through
one fixed `docker exec`. A replacement container under the configured name is
never signalled; cancellation reports `lost` instead.

`prepare` asserts an empty scope — no selection, no source SHA, and a
zero-material generation — and a resumed `prepare` against an existing job id
is accepted only when the record still carries that exact triple. `import`
records carry no scope at all and never execute.

Records written before scoped delivery read back with a null scope. They stay
readable by `status`/`show`/`costs` and cancellable through the verified
recorded-ID path, but they cannot be executed: there is no full-bundle fallback
to widen back into. Resubmit instead.

### Generation lifecycle and repair

Scoped material lives under `<root>/state/credentials-scoped` in three fixed
slots: `staging`, `active`, `recovery`. New material is staged while the old
container may still reference `active`; once the container is down, a
two-rename swap installs it. A failed or abandoned stage clears only `staging`,
and the next invocation repeats that cleanup, so an interruption does not
strand a slot. An interrupted swap is recovered on the next reconcile when only
`recovery` exists; when both `active` and `recovery` exist the appliance
refuses to guess between two complete generations and asks for manual repair.

Retiring a bundle is a manual operator procedure, in this order: down the
container, then remove `<root>/state/credentials-scoped`. There is no
subcommand for it.

### Bundle migration and rollback

The blessed bundle's `credentials.env` must supply the grader credential under
`QUORUM_GRADER_CLAUDE_CODE_OAUTH_TOKEN`,
`QUORUM_GRADER_ANTHROPIC_AUTH_TOKEN`, or `QUORUM_GRADER_ANTHROPIC_API_KEY`,
with at least one nonempty; `QUORUM_GRADER_ANTHROPIC_BASE_URL` alone is not
auth. The grader secret must be a **different value** from every secret
delivered to the agent, not merely a differently named copy of it: staging
compares the agent's delivered material against every grader auth value and
refuses on any equality, naming the channels and never the values. Duplicating
one Anthropic key under both an agent name and a grader alias is refused, and
the remediation is a separate grader key.

Rollback is a paired code-and-bundle operation. Keep a versioned backup of the
pre-migration bundle and restore it whenever you roll code back to before the
scoped cutover. Code-only rollback after alias migration is unsupported: it can
strand the grader or silently change its auth semantics.

Inside the container the supervisor env sets
`QUORUM_GRADER_SOURCE_MODE=appliance-scoped`, and in that mode the grader
credential is read only from the aliases. With the marker absent, trusted local
runs keep the canonical host contract unchanged. Any other explicit value,
including an empty one, is an error rather than an implicit source choice.

### Diagnostics and expected refusals

`doctor --json` reports `docker.exec_env_file`. When it is false, scoped
delivery cannot run at all, and preflight refuses at the same capability check
before build or staging.

A credential-bundle fault — missing directory, symlinked component, unreadable
or invalid `metadata.json`, or overlap with a code repo, the results root, or
the scoped state namespace — refuses `doctor`, `prepare`, `run`, and
`run-all`. It never blocks `status`, `show`, `costs`, `import`, `prune`, or
identity-verified `cancel`, which load only the structural config. Repair the
bundle, then resubmit.

Every appliance path is validated no-follow across every existing component
from the filesystem root down, and the scoped state namespace must be disjoint
from the code repos, the results root, and the bundle. Configure real paths,
not symlink aliases. `state/credentials-scoped` may hold only `staging`,
`active`, and `recovery`, each a real directory containing only real
directories and regular files; anything else refuses with a repair instruction
and performs no cleanup.

Source-SHA drift is an expected refusal after any upstream evals update: the
job resolved its scope at one commit and preflight has fast-forwarded past it.
Resubmit from a freshly loaded appliance process, so the persisted resolver
code, the selection, and the SHA all agree.

Mount signatures recorded before the scoped cutover describe a different
payload and are not comparable with signatures recorded after it. Do not diff
them across the upgrade.

### Isolation boundary and accepted residual

Filesystem scoping is a filesystem boundary. It does not provide UID isolation
and is not claimed to.

A process running as the same UID, or as root, can inspect other appliance
process state — including `/proc` of the live Quorum supervisor, and of the
Gauntlet child that legitimately holds the grader's secret values under the
canonical names. Neither host-only delivery of the supervisor exec env file
nor the `QUORUM_GRADER_*` aliasing is a defence against such an observer. The
Coding-Agent under test runs at that same privilege: intentional delivery
never hands it the grader's values, but nothing stops it from reading them out
of a peer process's environment. The Quorum parent and the `run-all` child also
retain the operator's full host provider bundle in their process environments
on host-driven paths, so same-UID inspection can expose every host provider
credential, not only the selected agent and grader credentials. Same-UID
inspection also reaches the fixed staging slot, which such a process can race
and displace while a generation is being written.

Staging detects that displacement and fails closed: the fixed path must still
identify the exact inode that was written, or the job is refused rather than
reported successful, and cleanup then locates the pinned generation by inode
among the entries of its pinned parent so it never deletes an unrelated
directory by name. A generation renamed entirely **outside** the scoped
namespace cannot be located and is left in place — the code cannot erase
secret bytes a same-UID process has moved somewhere it does not own.

Operators must therefore treat same-UID and root access to the appliance host
as trusted-maintainer scope. Stronger closure requires separate UID or host
isolation, which Phase 1 does not implement. This residual is accepted and
open, not fixed.

### Physical verification status

Automated behavior tests enforce the contract above. The local Docker canary
physically projected all ten credential rows and round-tripped all five
`docker exec --env-file` value forms; guest observation succeeded for eight of
ten rows. Antigravity and Kimi-without-optional intermittently could not see
their single-file bind under macOS/OrbStack even though Docker inspect reported
it, and focused probes did not reproduce that observation.

Two real Linux-appliance smoke jobs passed end to end: OpenCode with an API-key
credential and Claude with the Bedrock/Mantle bearer. Both exposed exactly the
selected agent file in the container, kept the supervisor file host-only, and
restored the original appliance checkout, bundle, locks, and legacy container
afterward. The attempted Codex-subscription job failed after the asserted-empty
Docker probe because the blessed bundle has no approved `codex/auth.json`; the
Codex path remains physically unverified and unavailable until that bundle
migration occurs. See the full positive and negative evidence in
[the F13 experiment receipt](experiments/2026-08-19-f13-filesystem-credential-scoping.md).

## Sentinel Batch

Start with the sentinel tier and a narrow target set. One appliance job carries
exactly one agent (see [Credential Scoping](#credential-scoping)), so a
multi-agent sweep is several jobs run one after another, not one batch:

```bash
evals-appliance run-all --json --detach \
  --superpowers-ref <branch-tag-or-sha> \
  -- --tier sentinel \
     --coding-agents claude \
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
or mis-built bundle is rejected whole. The bundle is also validated
structurally without following symlinks: the bundle root, `runs/`, and every
payload directory must be real directories holding only regular files, every
manifest path must be a plain relative path, and the files on disk must be
exactly the files the manifest lists — a symlink or special file anywhere in
the payload, an unlisted extra file, or a `run_id` in the reserved
`batches`/`batch-*` namespace (those names belong to batch artifacts and could
never be addressed by `status`/`show` again) rejects the bundle whole. The
appliance's own configured root, results root, and `state/` namespace are
validated no-follow across **every existing path component from the
filesystem root down** — an intermediate symlink anywhere in those paths
(say, `<root>/evals` pointing elsewhere) is rejected the same as a symlinked
final directory. Configure real paths, not symlink aliases; the appliance
never silently canonicalizes your configuration. Import refuses before
writing anything if any of this fails. It holds `run.lock`
for the duration; if a live job holds it, import returns `lock_busy` and does
nothing. Each run then lands by staging the payload beside the results root
and atomically renaming it into place — import never modifies or deletes a
landed run directory.
Re-running is safe: a run whose landed content already matches the bundle is
skipped, and if the run dir predates appliance job records — or a previous
recording was left incomplete — the record is healed in `state/` only (never
by writing inside the landed run) so `status`/`show` see it. Only a missing
state provenance marker is healed this way; a malformed one (a symlink,
directory, corrupt record, or one recorded for a different job) fails the
entry closed for manual repair. If the landed run
differs from the bundle, that
entry is rejected as `import_conflict`: the landed run stays byte-for-byte
untouched and the incoming payload is moved to `state/quarantine/` for
comparison — and if that quarantine move itself fails, the staged conflict
payload is retained beside the results root and the failure message names its
path so you can recover it. An entry whose `run_id` equals an unrelated job's
id is rejected
(`config_invalid`) so `status`/`show` stay unambiguous, and corrupt job
records under `state/jobs` fail entries closed for manual repair. Per-entry
failures are reported with `run_id`, code, and message in the JSON result,
and any failed entry makes the command itself fail: `ok: false` and a nonzero
exit, with the full result payload preserved. A
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
guess: a batch dir missing its canonical `batch.json` or `results.jsonl`
(an empty `results.jsonl` is a valid zero-row file), an unparseable or
non-canonical `results.jsonl` record, a corrupt job record under
`state/jobs`, any symlink or unreadable entry inside the batches, jobs, or
campaigns namespaces, or a configured root, results root, or `state/`
jobs/locks/provenance/quarantine root whose path is not real directories all
the way down — every existing component from the filesystem root is checked
no-follow, so an intermediate symlink (e.g. `<root>/evals` pointing at
another volume's results) refuses the plan just like a symlinked final
directory. Repair the state and rerun.

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
