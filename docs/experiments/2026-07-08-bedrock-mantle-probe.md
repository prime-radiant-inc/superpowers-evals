# Bedrock Mantle live probe — region / model / header / pricing (PRI-2517)

**Date:** 2026-07-08 · **Account:** <AWS_ACCOUNT_ID> · **Context:** validate the
Bedrock/Mantle facts the design (`docs/superpowers/specs/2026-07-08-bedrock-mantle-eval-auth-design.md`)
depends on, before implementing Phase 1.

## Questions
1. Does Mantle serve `opus-4-8` / `sonnet-5` / `haiku-4-5`, and in which region (us-east-1 vs us-west-2)?
2. Which auth header does Mantle accept — `x-api-key`, `Authorization: Bearer`, or both?
3. What model-id string does Mantle return (the obol pricing key), and does obol price it?

## Method
- Read-only discovery first: `aws bedrock list-foundation-models` + `list-inference-profiles`
  in us-east-1 and us-west-2. Both regions list all three models (INFERENCE_PROFILE-only,
  no on-demand) with `us.*` + `global.*` profiles ACTIVE — but that is the **Invoke** surface,
  not Mantle.
- Definitive Mantle test: created a dedicated least-privilege IAM user
  `<iam-user>` + `AmazonBedrockMantleInferenceAccess`, minted a temporary
  long-term Bedrock API key, and did tiny (`max_tokens: 8`) `POST /anthropic/v1/messages`
  calls to `bedrock-mantle.{region}.api.aws`. Key deleted after each battery (kept in-shell,
  never written to disk). Fresh keys took ~30s to propagate (polled, no `sleep`).

## Findings

| Region | Model id (request) | HTTP | `response.model` |
|---|---|---|---|
| us-east-1 | `anthropic.claude-opus-4-8` | **200** | `claude-opus-4-8` |
| us-east-1 | `anthropic.claude-sonnet-5` | **200** | `claude-sonnet-5` |
| us-east-1 | `anthropic.claude-haiku-4-5` | **200** | `claude-haiku-4-5-20251001` |
| us-east-1 | `anthropic.claude-sonnet-4-6` | **404** | — (`model does not exist`) |
| us-west-2 | `anthropic.claude-opus-4-8` | **404** | — (`model does not exist`) |
| us-west-2 | `anthropic.claude-sonnet-5` | **404** | — (`model does not exist`) |
| us-west-2 | `anthropic.claude-haiku-4-5` | 500 | — |

- **Region: us-east-1 only.** Mantle is In-Region-only; us-east-1 serves all three, us-west-2
  serves none of them. Co-locating Mantle with a *west* appliance box is not possible.
- **Header: both `x-api-key` and `Authorization: Bearer` return 200.** So the grader can map
  the bearer to `ANTHROPIC_API_KEY` (x-api-key) with no gauntlet auth-guard change.
- **Model id: Mantle returns the bare native id** in `response.model` (`claude-opus-4-8`,
  `claude-sonnet-5`, `claude-haiku-4-5-20251001`) — not the `anthropic.claude-*` request id.
- **Sonnet 4.6 confirmed NOT on Mantle** (404), validating the move to Sonnet 5.

### obol pricing of the returned ids (obol 0.6.0, `as_of 2026-06-08`)
| id | est_cost_usd |
|---|---|
| `claude-opus-4-8` | $0.0176 (priced) |
| `claude-haiku-4-5-20251001` | $0.0035 (priced) |
| `claude-sonnet-5` | **null** |

⟹ **obol Step 0 is narrower than the spec assumed: only `claude-sonnet-5` must be added.**
(Assumes Claude Code logs the Mantle `response.model`; a real CLI run confirms — the one
remaining gate.)

## Incident (recorded per the negative-results policy)
The first probe run mis-extracted the minted key: aws-cli 2.34 returns the value in
`ServiceSpecificCredential.**ServiceCredentialSecret**` (not `ServiceApiKeyValue`), so the
script's `[ -n "$KEY" ]` guard `exit 1`-ed **before** the cleanup trap was armed, and an error
branch printed `head -c 300` of the create-credential JSON — leaking a **truncated prefix** of
the secret into the transcript. Remediation: the credential was **deleted immediately**
(`aws iam delete-service-specific-credential`), which fully invalidates it, so there is no
lasting exposure. **Lessons:** (1) never echo `create-service-specific-credential` output on
any branch; (2) arm the delete trap *before* the mint can fail; (3) the aws-cli field is
`ServiceCredentialSecret`.

## Artifacts / follow-ups
- IAM user `<iam-user>` (+ `AmazonBedrockMantleInferenceAccess`) exists, **no key
  retained** — ready for the real bundle-key mint at appliance-prep time. Tighten to a custom
  policy (drop the managed policy's marketplace grant) before the default flip.
- Spec updated: region `us-east-1` confirmed, header resolved, obol Step 0 narrowed to
  `claude-sonnet-5`, open items trimmed.

## Still open (need the live Claude Code / appliance path)
- The literal `message.model` Claude Code logs on Mantle (expected `claude-*`).
- Mantle RPM/TPM account quota (drives `max_concurrency`).
- Prompt-caching parity in us-east-1 (cost comparability).
- No SCP cap on service-specific-credential age (never-expire assumption).
