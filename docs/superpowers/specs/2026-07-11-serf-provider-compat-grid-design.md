# Serf Provider Compatibility Grid — Design Specification

**Status:** Approved for implementation
**Date:** 2026-07-11
**Decision owner:** Drew

## Summary

Allow a Serf campaign credential to opt into Serf's existing
`tool_choice_auto_only` OpenAI-compatible model behavior. Quorum materializes a
credential-free `providers.toml` inside the isolated run home, and the existing
Serf launcher loads that file while forwarding only the selected API key.

Use this capability for provider endpoints that accept tool calling but reject
forced `tool_choice`. Keep other campaign cells unchanged. A strict hello grid
runs each `(model, provider)` cell once, with provider presets pinned and
fallbacks disabled.

## Problem

Serf's agent loop begins normal rounds with `tool_choice: required`. Some
OpenAI-compatible providers require `tool_choice: auto`. Serf already models
that wire quirk in `providers.toml`, but Quorum deliberately points each run at
a fresh nonexistent config so Serf seeds a generic provider from the selected
environment variable.

An OpenRouter preset is opaque to Serf: the wire model is
`@preset/<slug>`, so Serf cannot infer the underlying model/provider quirk.
The result is a deterministic provider 400 before any tool executes even though
the same request succeeds with `tool_choice: auto`.

## Credential contract

Extend the existing closed `compat` object with one optional boolean:

```yaml
compat:
  tool_choice_auto_only: true
```

Unknown compatibility keys remain errors. The new field is valid only for a
Serf OpenRouter campaign credential using the existing canonical preset,
base-URL, API, auth, and key-environment contract. Other credentials that set
it fail validation rather than silently ignoring it.

## Per-run provider config

When the field is true, Serf provisioning writes
`<run-home>/.serf/providers.toml` with mode `0600`. The file declares the
`openrouter` instance, references `$OPENROUTER_API_KEY` without containing its
value, declares the selected `@preset/<slug>` model, and enables only
`tool_choice_auto_only` for that model.

When the field is absent or false, provisioning preserves today's behavior:
the file remains absent and Serf seeds the provider from the isolated
environment.

The launcher keeps `env -i`, forwards only the credential-selected API key,
and keeps `SERF_PROVIDERS_CONFIG` inside the isolated run home. No host Serf
config, unrelated credential, prompt, response, or raw HTTP body enters the
run.

## Provider matrix discipline

Each campaign preset pins one provider and sets `allow_fallbacks: false`.
Campaign labels name that provider and its dated catalog quantization. A cell
cannot silently route to another provider to obtain a pass.

For MiniMax M3, use a ZDR-eligible provider that supports tools and forced tool
choice. The selected provider is Parasail: FP8, 1,048,576-token context, and
the campaign's full parameter surface at the current lowest endpoint price.

The smoke story instructs the evaluator to invoke the Coding-Agent exactly
once and never retry it. One Quorum cell therefore represents one Serf agent
attempt. Provider-internal request rounds remain part of that single attempt.

## Failure behavior

- Invalid compatibility placement fails `quorum check` before a paid run.
- Provider-config write failure stops provisioning.
- A provider 4xx is a strict cell failure; Quorum does not adapt the profile or
  retry the Coding-Agent.
- Missing route, usage, or cost attestation remains indeterminate and does not
  receive partial credit.

## Security and public-repository boundary

The repository contains only a generic compatibility field, credential-free
provider-config generation, and public tests/docs. Preset definitions,
campaign candidate files, API keys, run artifacts, prompts, responses, private
hostnames, and private product names remain outside source control.

## Testing and rollout

1. Add failing schema and Serf-provisioning tests.
2. Implement the smallest closed-schema and per-run config changes.
3. Add a failing story-contract test requiring exactly-one invocation wording,
   then update the public smoke story.
4. Run focused tests, the full Bun suite, and dashboard tests.
5. After the separate Serf stream-ID fix is pinned into the appliance image,
   run managed appliance preparation and `quorum check`.
6. Run the four-cell hello grid serially. A cell passes only with deterministic
   hello completion plus route, token, cache, cost, and timing evidence.

## Rollback

Revert the Quorum commit and restore the prior private campaign/preset version.
Existing credentials without the new field are byte-for-byte behaviorally
unchanged and need no migration.
