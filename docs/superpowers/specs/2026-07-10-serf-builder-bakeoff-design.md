# Serf Builder Bake-off in Quorum — Design Specification

**Status:** Approved direction; ready for implementation planning after written
spec review.
**Date:** 2026-07-10
**Grounded at:** `0728703`
**Decision owner:** Drew

## Summary

Use Quorum's existing Serf Coding-Agent target to run one strict, reproducible
Fractals build for every selected `(harness, model, provider)` candidate. The
benchmark input is a frozen, release-approved Superpowers-format specification
and implementation plan built for this scenario, not either of Quorum's
existing hand-authored Fractals fixtures.

Candidates live in an external campaign credentials file rather than the
canonical `credentials.yaml`. Each candidate points Serf at an OpenRouter preset
that pins one model and one provider with fallbacks disabled. A dedicated,
ZDR-enforced OpenRouter key supplies broad library access without placing secret
values in the repository or campaign file.

A cell passes only when Quorum's verdict is `pass`: Serf completed, capture is
valid, and all deterministic repository checks pass. Failed or indeterminate
cells remain visible for diagnosis but receive no partial credit and are not
ranked. Successful cells are compared directly on wall time, LLM duration,
input/output/cache-create/cache-read tokens, cache effectiveness, and cost. V1
does not compute a composite winner score.

## Problem

Provider experiments are useful but expensive, and provider choice can change
viability independently of model identity: a route can authenticate and stream
while still being unusably slow, and a model/provider endpoint can fail while
the provider's general status page remains green.

Running these experiments manually has four problems:

1. changing guardrails or provider settings between runs is error-prone;
2. each run is operationally heavy compared with a local Coding-Agent eval;
3. provider/model candidates are not expressed as a reusable matrix; and
4. economics and correctness evidence must be compared by hand.

Quorum already owns the missing mechanics: isolated Coding-Agent homes and
workdirs, scenario fixtures, credential matrices, scheduling, deterministic
post-checks, ATIF capture, token/caching economics, cost reporting, and batch
artifacts. The narrow work is to make the existing Serf target fully
credential-aware and add one campaign-grade scenario.

## Goals

- Run the same approved Fractals spec/plan once per selected Serf
  model/provider pair.
- Keep every cell isolated and seeded from byte-identical source artifacts.
- Require concrete completion: working repository, passing verification, and a
  Quorum `pass` verdict.
- Capture and compare cost, speed, token use, and caching.
- Support both `--jobs 1` baselines and later concurrent throughput smokes.
- Keep short-lived market candidates out of canonical `credentials.yaml`.
- Preserve a sanitized, immutable record of the effective campaign input with
  each batch.
- Reuse Quorum's existing result, economics, and triage paths rather than
  creating a second benchmark application.

## Non-goals

- Replacing downstream production validation. Quorum selects promising
  builders; promotion remains a separate decision.
- Adding statistical repetition. V1 runs each cell once. A maintainer may rerun
  an interesting or suspicious cell explicitly.
- Awarding partial credit for completed tasks. Any non-pass is not viable.
- Creating a composite quality/cost score.
- Adding a campaign database, mutable service, or new dashboard.
- Checking every experimental candidate into `credentials.yaml`.
- Supporting arbitrary custom Serf endpoints in v1. The campaign path is
  OpenRouter through Serf's existing `openrouter/` profile.
- Comparing BYOK and shared OpenRouter capacity in the same campaign key. BYOK
  routing priority is a separate experiment and requires an isolated API key.

## Current Repository Evidence

Quorum already supports Serf end to end:

- `coding-agents/serf.yaml` declares `runtime_family: serf`, its native ATIF
  export, normalizer, isolated home, and default credential.
- `coding-agents/serf-context/launch-agent` launches the real Serf CLI with an
  isolated home, `--plugin-dir`, `--export-atif`, `--dir`, and `--state-dir`.
- `src/agents/serf.ts` provisions the target and validates the Serf binary and
  Superpowers checkout.
- `src/normalize/serf.ts` and the capture registry normalize native Serf ATIF;
  the economics schema already carries input, output, cache-create, cache-read,
  duration, provider, model, and cost.
- `test/agent-serf.test.ts`, `test/normalize.serf.test.ts`, and the real Serf
  trajectory fixture cover the existing target.
- The container installs Serf from source.

Two gaps prevent a clean market matrix:

1. `$SERF_MODEL` is currently substituted from `cfg.model`, not the selected
   credential's `model` (`src/runner/index.ts`).
2. `coding-agents/serf.yaml` hard-requires `ANTHROPIC_API_KEY`, while an
   OpenRouter campaign must validate and forward only the selected credential's
   `api_key_env`.

Quorum also already has two Fractals scenarios, but neither is the required
input. They contain different, hand-authored 5-task and 7-task plans. This design
adds a new scenario around a campaign-specific, release-approved
Superpowers-format artifact pair.

## Scenario Package

Add `scenarios/serf-builder-fractals/` with the normal Quorum anatomy:

```text
scenarios/serf-builder-fractals/
├── story.md
├── setup.sh
├── checks.sh
├── baseline-manifest.json
└── fixtures/
    └── docs/
        └── superpowers/
            ├── specs/
            └── plans/
```

### Frozen input

The fixture is a purpose-built public source-tree snapshot. It preserves the
approved spec and plan byte-for-byte at their scenario paths and includes only
the source files required to execute and verify that plan. It is not exported
from a private repository or live run, and it does not copy `.git`.

`baseline-manifest.json` records a fixture schema version, the spec and plan
role paths, and a sorted list of every fixture path, file mode, and SHA-256. It
is content-addressed without recording an originating repository, commit, local
path, run identifier, or capture environment.

`setup.sh` uses the existing `init_repo_from_fixtures` helper. Every cell starts
from the same committed `main` baseline. `quorum check` validates the manifest
schema and declared fixture paths; the runtime precheck verifies the spec, plan,
and tree-manifest hashes before any paid Coding-Agent launch.

### Story

The scenario is restricted to `serf`. The Gauntlet-Agent tells Serf once to
execute the emitted implementation plan end-to-end, use its emitted spec as
context, and follow the Superpowers subagent-driven-development workflow. The
story does not name individual tasks, vary wording by candidate, choose models,
or add provider-specific steering.

The Gauntlet-Agent may answer ordinary workflow questions consistently, but it
must not repair code, reinterpret failed acceptance criteria, or give one
candidate extra implementation guidance.

### Deterministic checks

`checks.sh` is the correctness gate. Its `pre()` verifies the frozen repository,
artifact paths, `main` branch, and required Go toolchain. Its `post()` verifies:

- the expected Superpowers SDD skill invocation and subagent dispatch evidence;
- the required source and test files described by the emitted plan;
- `go test ./...`;
- a successful build of the Fractals CLI;
- the emitted plan's documented help and representative render commands;
- the emitted plan's documented invalid-input behavior; and
- delivery on the main checkout with committed work.

The checks transcribe the emitted plan's own acceptance commands. They do not
add hidden product requirements. Gauntlet's qualitative result remains useful
diagnostic evidence, but cannot turn a deterministic failure into a pass.

## External Campaign Credentials

Canonical `credentials.yaml` is for durable defaults and long-lived comparison
targets. Provider-market campaigns use a separate file supplied explicitly:

```text
quorum run scenarios/serf-builder-fractals --coding-agent serf --credentials-file /srv/quorum/campaigns/serf-builders-2026-07.yaml
quorum run-all --scenarios serf-builder-fractals --coding-agents serf --credentials-file /srv/quorum/campaigns/serf-builders-2026-07.yaml
quorum check scenarios/serf-builder-fractals --credentials-file /srv/quorum/campaigns/serf-builders-2026-07.yaml
```

The existing internal `credentialsPath` runner seam becomes a public CLI option
for `run`, `run-all`, and `check`. Omitting the option preserves today's
top-level `credentials.yaml` behavior.

The external file uses the same credential schema plus an optional closed
`labels` object:

```yaml
serf_glm52_deepinfra:
  model: openrouter/@preset/serf-glm52-deepinfra
  api: openai-chat
  base_url: https://openrouter.ai/api/v1
  api_key_env: OPENROUTER_API_KEY
  harnesses: [serf]
  labels:
    model: z-ai/glm-5.2
    provider: deepinfra
    quantization: fp4
    preset_version_id: 550e8400-e29b-41d4-a716-446655440000
    catalog_as_of: 2026-07-10
```

When `labels` is present, all five fields are required and unknown label keys
are rejected. Credential objects also become strict: unknown keys are a
validation error rather than being silently discarded. The implementation must
prove the canonical `credentials.yaml` passes strict parsing before enabling
this behavior.

The campaign author takes `quantization` from the provider endpoint catalog and
records the lookup date in `catalog_as_of`; `unknown` or `unverified` is rejected
for a full Fractals campaign. OpenRouter generation metadata attests the runtime
provider but does not currently attest quantization, so the dated catalog value
is the explicit evidence boundary.

The file contains references to environment variables, never secret values.
The OpenRouter key remains in the host/container/appliance credential bundle.

### Snapshot semantics

`run-all` parses and validates the external file before allocating work. At
batch start it writes a canonical, parsed copy to
`<batch-dir>/credentials.snapshot.yaml` and passes that snapshot path to every
child `quorum run`. Editing the source file during a batch therefore cannot
change later cells.

A direct `quorum run` writes the same canonical snapshot under its run
directory. Because only schema-known fields survive parsing and no secret-value
field exists, the snapshot is safe to preserve with the already-sensitive run
artifacts. Tests still scan the snapshot for the selected key value to catch an
accidental serialization regression.

After a campaign, the maintainer records its batch ids and conclusions in the
normal dated `docs/experiments/` log. Negative results receive the same record as
wins. Only a durable winner is eligible for promotion into canonical
`credentials.yaml`.

## Serf Credential Awareness

Serf remains one Coding-Agent target. Model/provider variants are credentials,
not sibling `coding-agents/serf-*.yaml` files.

### Model resolution

The runner substitutes:

```text
$SERF_MODEL = resolvedCredential.model ?? cfg.model
```

The fallback preserves direct/default behavior, while every named campaign
credential controls the actual Serf model reference. The selected model and
credential labels are stamped into `verdict.json` and batch records.

### Key resolution and forwarding

`coding-agents/serf.yaml` keeps `SUPERPOWERS_ROOT` in `required_env` but removes
the hard-coded `ANTHROPIC_API_KEY` gate. `SerfAgent.provision` receives the
resolved credential, supports `auth: api-key` for v1, and validates the key
through the shared credential resolver.

The launcher must stop forwarding every ambient provider key. The runner bakes
the selected credential's `api_key_env` name into a
`$SERF_API_KEY_ENV` substitution. At launch, the script reads that one ambient
variable indirectly and adds only that name/value to Serf's otherwise-clean
environment. The key name is visible in generated context; the key value is
not. A missing or empty selected key fails before Serf starts.

For the default `serf_default`, the selected name remains
`ANTHROPIC_API_KEY`. For campaign credentials it is
`OPENROUTER_API_KEY`. Serf's existing fresh `SERF_PROVIDERS_CONFIG` path makes it
seed the correct provider profile from that isolated environment.

V1 Serf campaign credentials must use the standard provider base URL implied by
the Serf model profile. `base_url` is still present as scheduler/provenance
identity (`https://openrouter.ai/api/v1` for these candidates), but this design
does not add custom Serf endpoint translation.

## OpenRouter Routing

Use one dedicated OpenRouter API key for a shared-capacity campaign:

- ZDR enforced by the key's data policy;
- broad access to the candidate model/provider set;
- a campaign-specific spend cap and activity log; and
- no BYOK credentials bound to the key.

The last rule avoids BYOK's routing priority changing an ostensibly pinned
shared-provider cell. A later BYOK campaign uses a separate OpenRouter API key
and separate candidate file so its results remain attributable.

Each candidate preset contains only routing identity:

```json
{
  "model": "z-ai/glm-5.2",
  "provider": {
    "order": ["deepinfra"],
    "allow_fallbacks": false
  }
}
```

Presets must not alter system prompts, temperature, reasoning effort, tool
choice, token limits, or other generation parameters. Those would create a
different harness rather than a model/provider comparison.

OpenRouter preset references resolve to the latest designated version. Before a
campaign, the operator records the active designated-version id in the candidate
label and does not edit the preset until the batch finishes. The credentials
snapshot preserves that claimed version.

### Runtime route attestation

Preset configuration is intent, not runtime proof. Serf's native ATIF export
preserves response ids on assistant steps. For OpenRouter profiles those ids use
the `gen-` prefix. After capture, Quorum queries
`GET https://openrouter.ai/api/v1/generation?id=<generation-id>` with the
selected campaign key and writes the content-free metadata to
`<run-dir>/openrouter-generations.json`.

The attestation contains, per generation:

- generation id;
- requested/served model;
- `provider_name`;
- `preset_id`;
- `is_byok`;
- latency and generation time;
- native prompt, completion, reasoning, and cached token counts; and
- OpenRouter's charged `total_cost` and upstream inference cost when present.

The capture never calls the generation-content endpoint and never stores prompts
or completions. A campaign cell requires every OpenRouter generation id in the
trajectory to resolve. Every record must report the candidate's provider, the
expected shared-key `is_byok: false`, and the candidate model after normalizing
OpenRouter's dated served-model suffix. A mismatch, missing generation, or
metadata fetch failure makes the cell indeterminate and non-comparable.

Provider labels use OpenRouter slugs; `provider_name` is compared after
lowercasing and normalizing spaces and punctuation to hyphens. Model comparison
accepts only the labeled model or its dated served-model form.

For OpenRouter candidates, summed generation `total_cost` is the authoritative
charged cost. ATIF/obol cost and token totals remain an independent cross-check.
The comparison row shows both values and their delta; it does not invent a
threshold or silently select the estimate over the charged cost.

OpenRouter documents the generation endpoint as the historical audit path for
provider, token, latency, BYOK, and cost metadata:
<https://openrouter.ai/docs/api/api-reference/generations/get-generation>.

## Execution Flow

### Preflight smoke

Before the expensive Fractals scenario, run the same candidate list against the
existing `00-quorum-smoke-hello-world` scenario with Serf. This is a real
end-to-end smoke: credential selection, key forwarding, preset resolution, Serf
tool use, ATIF capture, OpenRouter route attestation, and deterministic checks
all execute.

The current smoke story names Claude in its prose even though its checks are
agent-agnostic. Before using it as the campaign preflight, make that wording
Coding-Agent-neutral without changing its task or acceptance criteria.

```bash
quorum run-all \
  --scenarios 00-quorum-smoke-hello-world \
  --coding-agents serf \
  --credentials-file /srv/quorum/campaigns/serf-builders-2026-07.yaml \
  --credentials serf_glm52_deepinfra,serf_glm52_fireworks \
  --jobs 1
```

Only smoke-pass candidates proceed to Fractals. A provider/model mismatch,
unexpected BYOK route, endpoint outage, missing generation attestation, missing
trajectory, or tool-call failure is a non-pass and prevents the expensive run.

### Full batch

```bash
quorum run-all \
  --scenarios serf-builder-fractals \
  --coding-agents serf \
  --credentials-file /srv/quorum/campaigns/serf-builders-2026-07.yaml \
  --credentials serf_glm52_deepinfra,serf_glm52_fireworks \
  --jobs 1
```

V1 executes one cell per credential. It does not auto-repeat or auto-retry a
candidate. If the general transient-retry work lands first, this campaign uses
its zero-retry setting so one candidate still means one paid attempt.

`--jobs 1` is the clean latency/cost baseline. The same candidate file may later
be rerun with `--jobs N` on the dedicated server to measure contention and
throughput. That concurrent batch is a separate experiment, not a repetition
folded into the sequential result.

## Verdict and Ranking

The Quorum verdict remains three-valued for diagnosis:

- `pass` — viable and eligible for comparison;
- `fail` — behavior or deterministic acceptance failure; and
- `indeterminate` — setup, provider, capture, or harness evidence failure.

At the campaign layer, only `pass` is viable. `fail` and `indeterminate` both
receive no score and no rank. The distinction remains visible so a model-quality
failure is not confused with an outage or measurement failure.

Successful candidates are not collapsed into a composite score. The operator
compares the concrete metrics and chooses the appropriate cost/speed frontier.
Only Coding-Agent cost participates in that comparison; Gauntlet-Agent cost is
reported separately as harness overhead.

## Metrics and Presentation

Quorum already writes `coding-agent-token-usage.json` with:

- total input;
- total cache creation;
- total cache reads;
- total output;
- total tokens;
- per-model provider and token buckets;
- estimated cost and pricing status; and
- Coding-Agent duration.

Credential `labels` are threaded through `MatrixEntry`, `ResultRecord`, and
`FinalVerdict` as optional, backward-compatible fields. Old results without
labels continue to parse.

`quorum show <batch>` remains the compact pass/fail matrix. For batches carrying
candidate labels, `quorum costs <batch>` becomes the builder comparison view,
one row per cell, with:

| field | source |
|---|---|
| credential | result identity |
| model | credential label |
| provider | credential label + generation attestation |
| quantization | credential label |
| final verdict | `verdict.json` |
| wall time | verdict timestamps |
| Coding-Agent duration | token-usage sidecar + generation metadata |
| input tokens | token-usage sidecar |
| cache-create tokens | token-usage sidecar |
| cache-read tokens | token-usage sidecar |
| output tokens | token-usage sidecar |
| cache-read percentage | `cache_read / (input + cache_read)` |
| charged cost | summed generation metadata for OpenRouter |
| estimated cost | token-usage sidecar cross-check |
| pricing status | unpriced/approximation fields |

The charged/estimated cost columns cover the Coding-Agent only. Existing
`--with-gauntlet` behavior can add Gauntlet-Agent cost for operational budgeting
without changing the builder comparison.

No missing measurement is shown as zero. The campaign capture guard converts a
missing or partial economics record to an indeterminate verdict even when the
repository checks passed, so every viable cell is also comparable.

## Failure Behavior

The system fails before paid execution when:

- the external credentials file is absent or invalid;
- a requested credential is absent;
- a credential does not list the `serf` harness;
- required labels are incomplete;
- the selected API key environment variable is missing;
- the frozen artifact hash check fails; or
- the Serf binary or Superpowers checkout is unavailable.

During execution, timeout, nonzero Serf exit, provider error, missing/invalid
ATIF, missing token evidence, missing/mismatched OpenRouter generation metadata,
Gauntlet failure, or deterministic post-check failure yields a non-pass. Quorum
preserves the existing stage and reason in the verdict and batch artifacts.

The runner does not silently switch credentials, models, providers, presets, or
fallback routes. A candidate must either run as declared or fail.

## Security

- Campaign YAML contains only public routing metadata and secret env-var names.
- Public scenario fixtures and documentation contain no non-public product
  names, repository identities, commits, local paths, run identifiers, service
  addresses, or unreviewed source-tree contents.
- The dedicated OpenRouter key is supplied through the normal trusted
  host/container/appliance credential bundle.
- Serf receives only the selected credential's provider key, not every provider
  key present in the parent process.
- Generated launcher context contains the selected env-var name but never its
  value.
- Credentials snapshots are canonical parsed output and are regression-scanned
  against the live secret value.
- Run artifacts remain sensitive because they contain model transcripts and
  filesystem state even when no key leaks.
- Live runs remain trusted-maintainer operations and never enter public CI.

## Tests and Definition of Done

### Hermetic tests

- CLI parsing and forwarding for `--credentials-file` on `run`, `run-all`, and
  `check`.
- Default behavior still reads top-level `credentials.yaml` when the option is
  absent.
- Strict parsing rejects unknown credential and label fields; canonical
  `credentials.yaml` remains valid.
- Batch-start snapshot is canonical and immutable; children receive the
  snapshot path, not the mutable source path.
- Snapshot serialization never contains the selected secret value.
- Serf substitutes `credential.model`, falling back to `cfg.model` only when no
  credential is selected.
- Serf resolves and forwards exactly one selected key environment variable.
- Anthropic `serf_default` behavior remains valid.
- OpenRouter preset refs survive launcher substitution byte-for-byte.
- OpenRouter generation capture uses an injectable HTTP seam; fixture responses
  cover correct route, wrong provider, unexpected BYOK, dated-model
  normalization, missing generation, 401, 404, 429, and 5xx behavior.
- Generation capture stores metadata only and never calls or serializes the
  generation-content endpoint.
- OpenRouter charged cost sums across generations; the renderer shows the
  ATIF/obol estimate and explicit delta alongside it.
- Candidate labels round-trip through matrix, result, verdict, batch render, and
  cost render; old unlabeled artifacts still parse.
- Cache percentage handles zero denominators and never double-counts cache-read
  tokens as ordinary input.
- Scenario fixture-integrity validation detects a modified spec, plan, or
  baseline-tree manifest.
- `quorum check scenarios/serf-builder-fractals --credentials-file
  test/fixtures/serf-campaign-credentials.yaml` passes.

### Repository gates

```bash
bun run check
bun run quorum check
git diff --check
```

### Trusted live acceptance

1. Run the hello-world Serf smoke against one known-good OpenRouter preset.
2. Verify the resulting verdict, trajectory, generation attestation,
   model/provider identity, token buckets, caching buckets, charged and
   estimated cost, duration, and credential labels.
3. Run one Fractals candidate with `--jobs 1` and prove strict post-checks and
   the comparison row.
4. Run two smoke candidates concurrently on the target server and confirm both
   attribution records remain distinct and economics do not cross-contaminate.
5. Do not launch the full market matrix until steps 1–4 pass.

## Operational Sequence

1. Author and review the public Fractals fixture and its content manifest.
2. Implement and statically validate the new scenario package.
3. Add external credentials-file plumbing and immutable snapshotting.
4. Make Serf credential-aware and narrow its key forwarding.
5. Thread labels through results and the comparison renderer.
6. Create the dedicated ZDR OpenRouter key and candidate presets outside Git.
7. Run the sequential hello-world smoke.
8. Run the small parallel smoke.
9. Run one sequential Fractals cell per smoke-passing candidate.
10. Record sanitized outcomes, including failures, in `docs/experiments/` after
    public-release review; keep raw run artifacts and external campaign inputs
    outside Git.

## Expected Repository Impact

The durable repository surface stays small:

- one scenario package;
- one agent-neutral wording correction to the existing smoke story;
- one generic CLI input option;
- one general Serf credential-resolution correction;
- optional credential labels in existing result contracts; and
- richer existing batch cost rendering.

Candidate proliferation remains outside the repository. The winning durable
builder may be promoted later through a separate, explicit change.
