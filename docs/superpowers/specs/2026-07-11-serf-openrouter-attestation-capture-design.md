# Serf OpenRouter Attestation Capture — Design Specification

**Status:** Approved for implementation
**Date:** 2026-07-11
**Decision owner:** Drew

## Summary

Make Serf/OpenRouter campaign runs retain the OpenRouter generation identifiers
that Quorum needs for route and cost attestation. Serf already supports this
through its explicit `raw-local` ATIF provider-handle export mode; Quorum's Serf
launcher must opt into that mode when writing the per-run ATIF artifact.

At the same time, update the container's exact Serf source pin to the current
reviewed `main` SHA. The pin remains an immutable commit, and the container's
existing tool-version report remains the provenance record.

## Problem

Serf's ATIF export defaults to redacting provider response identifiers. That is
the safe general default, but a labeled OpenRouter campaign has a stricter local
evidence requirement: Quorum reads each agent step's OpenRouter `gen-...`
identifier and queries OpenRouter's generation API to attest the effective
model, provider, preset version, BYOK state, token usage, and charged cost.

Without raw local provider handles, a successful model call can produce valid
token evidence but no generation identifiers. Quorum then correctly marks the
cell indeterminate because it cannot prove the route. Rebuilding the same
launcher with a newer Serf binary does not change this default.

## Design

### Launcher contract

Add the following argument to the existing one-shot Serf launch command:

```text
--export-atif-provider-handles raw-local
```

This is a fixed operator-authored launcher argument. It is not supplied by a
scenario, credential file, model, provider, or evaluated agent.

The existing `--export-atif` path remains inside the isolated per-run Serf
home. The normalizer remains a near-passthrough and preserves `step.extra`;
Quorum's existing OpenRouter capture path therefore receives each `response_id`
without a second parser or raw HTTP logging.

### Serf source pin

Advance `container/Dockerfile`'s `SERF_REF` default from its current immutable
commit to the exact reviewed Serf `main` commit selected for this campaign.
Container builds continue to clone Serf, check out that SHA, write it to
`/usr/local/share/serf-source-rev`, build `/usr/local/bin/serf`, and include the
source SHA in `evals-tool-versions` output.

No floating branch is embedded in the image.

## Security and artifact boundary

Raw provider response identifiers are sensitive operational metadata. They may
exist only in the private per-run ATIF artifact, the private closed-shape
OpenRouter attestation sidecar (`openrouter-generations.json`), and the
transient in-memory attestation request. Existing result-directory handling
already treats run homes, trajectories, and attestation sidecars as sensitive.

The public repository receives only:

- the fixed launcher flag;
- an immutable public Serf commit SHA; and
- tests asserting the launcher and container provenance contracts.

The private OpenRouter attestation sidecar continues to contain only its
existing closed metadata shape, including `generations[].id`; it does not
contain prompts or response bodies. No prompt, response body, credential,
provider key, private hostname, run identifier, or private repository
information is added to source control or public documentation.

## Failure behavior

- If Serf cannot accept the provider-handle flag, launch fails rather than
  silently producing unattestable evidence.
- If a provider response contains no OpenRouter generation ID, Quorum's
  existing attestation gate remains fail-closed and the cell is indeterminate.
- Z.AI's first-party GLM route is not a viable Serf campaign candidate while it
  requires `tool_choice: auto`: Serf's agent loop uses forced and named tool
  choices. This is a provider-compatibility failure, not an attestation-capture
  failure; a tool-choice-capable route such as Fireworks remains necessary for
  that model.
- Provider HTTP errors, guardrail exclusions, and BYOK mismatches remain
  independent campaign failures; this change does not reinterpret them.
- No paid campaign is automatically retried as part of image deployment.

## Testing

Use test-first coverage at the existing boundaries:

1. Update the Serf launcher test to require the fixed
   `--export-atif-provider-handles raw-local` argument and observe it fail before
   changing the launcher.
2. Update the container contract test to require the new exact Serf source pin
   and observe it fail before changing the Dockerfile.
3. Run the focused launcher/container tests, then the repository check suite.
4. Rebuild through the managed appliance preflight and verify the running
   container reports the expected Serf source SHA.
5. Run only non-paid version, configuration, and ATIF-export sanity checks.
   A new paid model smoke requires a separate explicit launch decision after
   provider and guardrail failures are understood.

## Deployment and rollback

Before rebuilding, record the current container image ID, Serf source SHA, and
binary digest. The managed appliance preflight builds the intended evals ref,
reconciles the long-lived container, records tool versions, and runs `quorum
check`.

Rollback is to rebuild the prior evals commit, which restores both the previous
Serf pin and launcher behavior, then rerun the same managed preflight. No
credential or result artifact needs migration.
