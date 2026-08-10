# Importing Locally-Run Results Into The Appliance

Status: approved 2026-08-09. Supersedes nothing.

Two corpora of quorum runs were produced on Jesse's laptop before the shared
appliance existed. They hold the only copy of several experiment campaigns.
This design moves them onto the appliance as first-class artifacts that
`evals-appliance status/show/costs` can read, without moving the credentials
they accumulated along the way.

## The Corpora

| corpus | runs | size | `auth.json` files |
|---|---|---|---|
| `evals-lane-b/results` | 346 | 23 GB | 245 |
| `superpowers/evals/results` | 280 | 39 GB | 261 |
| **total** | **626** | **62 GB** | **506** |

Three properties of this data drive the whole design.

**They are runs, not batches.** Zero of the 617 top-level directories contain a
`batch.json`. In `evals-lane-b`, 327 of 344 hold exactly one run directory and
17 hold two; `superpowers/evals` has the same shape. They are single
`quorum run` invocations grouped under experiment labels. The import
unit is therefore the run, and `results_root/batches/<id>` is not where they
land.

**They carry live credentials.** Every run kept its throwaway `$HOME`. 506 of
those homes contain `.codex/auth.json` with a usable `access_token` and
`refresh_token`; 370 run directories also carry a `credentials.snapshot.yaml`
naming the whole credential registry. None of this may reach a shared host.

**The bulk is disposable.** Of 62 GB, the analytically meaningful payload is
about 2.2 GB per the table in "Payload" below. The rest is npm and bun caches,
sqlite logs, and archived plugin trees.

## Recovering The Superpowers Rev

`verdict.json` carries a best-effort `provenance.superpowers_rev`, but it is
null for 332 of 626 runs — entirely codex, gemini, and claude runs, because
those harnesses installed superpowers by mount or link rather than by a probe
that recorded a sha.

For codex the rev is nonetheless recoverable, exactly. Codex archives a full
content copy of the superpowers tree into
`home/.codex/plugins/cache/debug/superpowers/local/`. Hashing that tree's
`skills/` directory into the superpowers object store yields a tree sha, and
searching history for commits whose `skills` subtree matches that sha
identifies the commit. Where several commits share an identical `skills` tree —
a docs-only commit stacked on a real one — the run's `started_at` selects the
newest match that precedes it.

Gemini and claude archive nothing. Gemini's extension is installed as
`{"source": "/workspace/superpowers", "type": "link"}` and claude's
`plugins/data/superpowers-inline` is empty. For those the rev is genuinely
unrecoverable from the artifacts.

This yields a five-state recovery ladder, recorded per run. Counts are the
measured result of exporting both corpora:

| status | meaning | count |
|---|---|---|
| `recorded` | the verdict already had it | 294 |
| `recovered` | tree hash matched history (timestamp breaks ties) | 217 |
| `tree_only` | tree hash computed, no commit matches — the run used a modified tree | 68 |
| `inferred` | borrowed from the nearest co-temporal run in the same campaign | 47 |
| `unknown` | no evidence at all | 0 |

511 runs carry an exact sha. The 68 `tree_only` runs are the experiment arms
that ran a modified superpowers tree — a real finding, and their tree hash still
identifies which arm uniquely. The 47 `inferred` are exactly the gemini and
claude runs predicted above; an inferred sha is stored in a distinct field and
never presented as recovered.

Inference is scoped to the campaign (the first two segments of an experiment
label, so `cx-eff-cc-ceremony-arch-dev-rep1` is `cx-eff`) rather than the
experiment directory, because arms are agent-specific: a gemini-only arm has no
sibling to learn from, but its campaign does. A 24-hour window bounds it —
superpowers moves several times a day mid-campaign, so a run with no closer
neighbour stays `unknown` rather than borrowing a probably-wrong sha. Every one
of the 47 had a same-campaign neighbour within 1.1 to 15.6 hours (median 3).

Recovery reads `home/`, which is also what gets discarded. Export therefore
mines the sha before scrubbing, and the appliance never needs the 60 GB.

## Architecture

Two commands with a bundle between them.

```
laptop                                    appliance
------                                    ---------
quorum export-runs <results-dir>
  scan runs
  recover superpowers rev  <- reads home/
  scrub to allowlist       -> drops home/
  write manifest+checksums
        |
        v
  <bundle>  --------- transfer ---------> evals-appliance import <bundle>
                                            verify checksums
                                            reject credential-shaped paths
                                            write job records + provenance
                                            land payload in results_root
```

The split follows the boundary the codebase already draws: `quorum` owns
`results/`, `src/appliance/` owns job records. It also means the secrets are
removed on the machine that already has them, and the bundle is an inspectable
artifact that can be audited before it crosses to a shared host.

### Export: `quorum export-runs`

```
quorum export-runs <results-dir> --out <bundle-dir> [--superpowers-repo <path>]
                   [--limit N] [--only <glob>]
```

Lives in `src/export-runs/`. A run is any directory holding a `verdict.json`,
found at any depth: the canonical layout is `results/<label>/<run-id>/`, but
quarantine sweeps move a whole label tree under a holding directory and put its
runs one level deeper. The first export scanned exactly two levels and silently
missed 55 such runs across the three corpora — they were only noticed because
the thinning pass refused to delete homes it could not find in a manifest.
Descent stops at the first marker found, and never enters `home/`,
`coding-agent-workdir/`, or `gauntlet-agent/`, so a scenario that exercises
quorum itself cannot have its nested fixture verdicts mistaken for runs.

For each run directory:

1. Parse the verdict with `FinalVerdictSchema`. An unparseable verdict is
   skipped and recorded in the manifest as `skipped` with its reason; it never
   aborts the export.
2. Resolve the superpowers rev via the ladder above. Commit matching uses
   `git cat-file --batch-check` over `rev-list --all` in one pass, with the
   commit-to-tree map cached across runs so 626 runs cost one traversal.
3. Copy the payload allowlist into `<bundle>/runs/<run-id>/`.
4. Append a manifest entry.

`--superpowers-repo` defaults to a sibling `superpowers` checkout and is
required only when some run needs `recovered` status; without it those runs
degrade to `tree_only` with the tree sha still recorded.

### Payload

An allowlist, not a denylist. Only these are copied:

| path | source | size (both corpora) |
|---|---|---|
| `verdict.json`, `trajectory.json`, `coding-agent-token-usage.json`, `phase.json` | run root | 237 MB |
| `gauntlet-agent/` | run root | 0.5 GB |
| `coding-agent-workdir/` | run root | 1.1 GB |
| `raw-sessions/` | lifted from `home/<agent-cfg>/sessions/` | 0.4 GB |

Everything else under `home/` is dropped, including `auth.json`, the npm and
bun caches, sqlite logs, and the archived plugin trees.
`credentials.snapshot.yaml` is dropped: it is a registry listing, and the
credential actually used is already named in `verdict.credential`.

Vendored dependency trees inside `coding-agent-workdir/` — `.venv`,
`node_modules`, `__pycache__`, and the mypy/pytest/ruff caches — are excluded.
They are reproducible bulk the agent's toolchain materialized rather than
authored, and they vendor CA trust stores (certifi's `cacert.pem`) that are not
credentials but match the denylist exactly; the first real export run aborted on
one. The agent's own `.git` is kept: its commits are genuine output that the
campaign reports cite.

Raw sessions are kept because `trajectory.json` is a normalized projection of
them; keeping the source means a future normalizer fix can be replayed.

### Bundle Format

```
<bundle>/
  manifest.json            # schema_version, source host, created_at, entries[]
  runs/<run-id>/           # the payload above, one dir per run
```

Each manifest entry records: `run_id`, source path, scenario, coding agent,
credential name, `started_at`/`finished_at`, final verdict, the recovery status
plus `superpowers_sha` / `superpowers_tree_sha` / `inferred_superpowers_sha`,
`harness_rev`, and a sha-256 for every copied file.

The credential *name* travels (it is already in the verdict and is not a
secret); no credential *material* does.

### Import: `evals-appliance import`

```
evals-appliance import --json <bundle-dir> [--force]
```

Lives in `src/appliance/import.ts`, wired into the appliance CLI alongside
`doctor`/`prepare`/`run`. It:

1. Acquires `run.lock`, so an import cannot interleave with a live batch
   writing `results_root`. A busy lock returns `lock_busy` and imports nothing.
2. Parses `manifest.json` and verifies every recorded sha-256. A mismatch fails
   the whole import before anything lands.
3. Rejects the bundle if any path matches the credential denylist —
   `auth.json`, `credentials.snapshot.yaml`, `*.pem`, `*.key`, `.env*`,
   `config.toml`. The export allowlist should make this unreachable; it is the
   backstop that makes the guarantee checkable at the boundary rather than
   trusted from the sender.
4. For each entry, writes a job record and provenance, then moves the payload
   to `<results_root>/<run-id>/`.
5. Is idempotent on `run_id`: an already-present run is skipped unless
   `--force`, which replaces it. Interrupted imports resume by re-running.

### Schema Changes

`ApplianceCommandKindSchema` gains `'import'`.

`JobRecordSchema` gains an optional `origin` block, absent on live jobs:

```ts
origin: z.object({
  kind: z.literal('imported'),
  imported_at: z.string(),
  source_host: z.string(),
  source_path: z.string(),
  superpowers_sha: z.string().nullable(),
  superpowers_tree_sha: z.string().nullable(),
  inferred_superpowers_sha: z.string().nullable(),
  rev_recovery: z.enum(['recorded','recovered','tree_only','inferred','unknown']),
  harness_rev: z.string().nullable(),
}).optional()
```

An imported job sets `kind: 'import'`, `refs: null`, `credential_bundle: null`,
`container: null`, `process: null`, `status: 'done'`, `artifacts.run_id` to the
run id, and `result.exit_code` mirroring the verdict (0 for pass, 1 otherwise).

`refs` stays strict and null rather than being loosened to accept partial data.
Loosening `RefSnapshotSchema` would weaken the guarantee for live jobs, which
is the opposite of what it exists for. Everything an imported run knows about
its provenance lives in `origin`, where its uncertainty is explicit.

`ProvenanceRecordSchema` gains a parallel imported variant with the same
reasoning: `refs` and `credential_bundle` are required for live provenance and
absent for imported provenance, discriminated on a `kind` field.

`summary.ts` renders an imported job by showing `origin` in place of the refs
and bundle block. `status` reports `done` with an `imported` marker so an
imported run is never mistaken for something this appliance executed.

## Errors

Export is per-run fault-tolerant: an unreadable verdict, a missing payload
directory, or a failed tree hash marks that run `skipped` with a reason and
continues. The manifest is the report; the summary line prints the counts by
status. An unwritable bundle directory or a missing results directory is fatal
before any work starts.

Import is all-or-nothing on validation and per-run on landing. Checksum
mismatch, denylist hit, or malformed manifest aborts before the first run lands.
After validation, a per-run failure is recorded and the remaining runs proceed,
because a partial import is resumable and a half-validated one is not.

## Testing

Unit tests over a fixture bundle, following the existing `appliance-*.test.ts`
pattern with a tmpdir config:

- rev recovery: each of the five ladder states, including the two-commit tie
  broken by `started_at`, and a modified tree yielding `tree_only`
- scrub: a fixture run containing `auth.json` and `credentials.snapshot.yaml`
  produces a bundle containing neither, asserted by walking the output
- manifest: checksums match; a corrupted payload byte fails import
- denylist: a hand-built malicious bundle with `auth.json` is rejected
- idempotency: importing twice lands one copy; `--force` replaces
- schema: an imported job round-trips `JobRecordSchema`; `summary.ts` renders it
- lock: import refuses when `run.lock` is held

The end-to-end check is the real export: 626 runs, then a walk of both bundles
asserting zero credential-shaped files and recovery-status counts matching the
294 / 285 / 47 prediction.

Measured result, 2026-08-09:

- 626 runs exported, 0 skipped, 62 GB in, 2.4 GB out
- 0 credential-shaped paths in either bundle; grepping both for the actual
  token values taken from 9 source `auth.json` files finds nothing
- recovery: 294 recorded, 217 recovered, 68 tree_only, 47 inferred, 0 unknown
- both bundles import cleanly into a throwaway appliance state dir (346 in
  8.8s, 280 in 8.0s), and a second import of each is a no-op

Second pass, 2026-08-10, after the discovery depth was fixed:

- 55 further runs exported incrementally (22 lane-b, 25 corpus B, 8 from a third
  tree, `results-quarantine-setupstubs/`, found during the same sweep), each
  bundle excluding the prior manifest so no already-thinned run was re-exported
- recovery: 46 recorded, 9 unknown — the unknown are setup-stub and pre-check
  failures that never installed superpowers, so no evidence exists to recover
- 0 credential-shaped paths; grepping the three bundles for the 10 real token
  values in the source `auth.json` files finds nothing
- all 55 imported, 0 failed; `status`, `show`, and `costs` read them
- appliance now holds 681 imported runs

## Out Of Scope

Deleting the local corpora. Export copies; the originals stay until Jesse
decides otherwise.

Backfilling the harness so future codex/gemini/claude runs record their rev.
That is a real gap this work surfaced, and it belongs in its own change.
