# PR 2258 parallel comparison pricing

This directory freezes the four public primary-model list rates verified on
September 5, 2026 for the proposed PR 2258 comparison. Values are USD per one
million tokens. The snapshot is intentionally experiment-specific.

| Model | Route and scope | Input | Cache read | Cache write | Output |
| --- | --- | ---: | ---: | ---: | ---: |
| `gpt-6-astra` | OpenAI Responses, Standard | 10.00 | 1.00 | 12.50 | 50.00 |
| `gpt-5.6-sol` | OpenAI Responses, Standard | 4.00 | 0.40 | 5.00 | 20.00 |
| `anthropic.claude-opus-5` | AWS Mantle, us-east-1 In-Region, Standard | 5.50 | 0.55 | 6.875 (5m), 11.00 (1h) | 27.50 |
| `anthropic.claude-sonnet-5` | AWS Mantle, us-east-1 In-Region, Standard | 2.20 | 0.22 | 2.75 (5m), 4.40 (1h) | 11.00 |

For Astra and Sol, requests above 272,000 input tokens price the full request
at twice the input/cache rates and 1.5 times the output rate. The snapshot does
not invent a separate long-context tier for the Mantle models because AWS does
not publish one for these routes.

Authoritative sources checked on September 5, 2026:

- OpenAI model pages for
  [`gpt-6-astra`](https://developers.openai.com/api/docs/models/gpt-6-astra)
  and
  [`gpt-5.6-sol`](https://developers.openai.com/api/docs/models/gpt-5.6-sol),
  plus [OpenAI API pricing](https://developers.openai.com/api/docs/pricing).
- AWS model cards for
  [Claude Opus 5](https://docs.aws.amazon.com/bedrock/latest/userguide/model-card-anthropic-claude-opus-5.html)
  and
  [Claude Sonnet 5](https://docs.aws.amazon.com/bedrock/latest/userguide/model-card-anthropic-claude-sonnet-5.html),
  plus [Amazon Bedrock pricing](https://aws.amazon.com/bedrock/pricing/) under
  Geo and In-region Cross-region Inference, Anthropic, US East (N. Virginia).
  The AWS table resolves price tokens through its public
  [`bedrockfoundationmodels` USD map](https://b0.p.awsstatic.com/pricing/2.0/meteredUnitMaps/bedrockfoundationmodels/USD/current/bedrockfoundationmodels.json),
  published September 1, 2026.

The snapshot covers the requested primary IDs and the observed Mantle Opus subject ID. It does not establish the
IDs returned by the installed services, delegated models, Standard-tier
routing, cache-duration capture, separately billed tools, private discounts or
invoice parity. In particular, the Claude subject trajectory currently merges
cache creation into one bucket even though Mantle prices five-minute and
one-hour writes differently. The Codex trajectory does not establish explicit
cache-write coverage. Those are preflight blockers until installed
qualification verifies the actual worker behavior; adding a price row would
not repair missing usage evidence.

Run the offline boundary and bucket probe with the snapshot selected explicitly:

```sh
OBOL_PRICING_DIR="$PWD/docs/experiments/2026-09-05-pr2258-parallel-pricing" \
  bun run docs/experiments/2026-09-05-pr2258-parallel-pricing/verify.ts
```

The probe calls the same Quorum accounting functions used by capture. It checks
the OpenAI 272,000/272,001-token boundary, both Mantle cache-write durations,
and fail-closed handling of an unknown model. It makes no provider request.
Installed qualification must stage the exact snapshot bytes, run the probe in
the worker without an override, and record the same SHA-256:
`609f6cbb26be00d29be02614c22abeeb556c9d2235f53d1e830b949cca3b1c6f`.

## Observed Mantle subject identifier

The six-attempt diagnostic at Evals `c3e1c440` returned `claude-opus-5`
in both Claude subject trajectories, while the requested Mantle model was
`anthropic.claude-opus-5`. This experiment-scoped snapshot prices both IDs at
the same verified US East (N. Virginia) In-region rates. It does not assign
Mantle prices to that identifier in a global registry or another route.
The Sonnet grader usage retains its `anthropic.claude-sonnet-5` identifier.

The offline probe includes the observed subject identifier through the real
ATIF accounting wrapper. Its missing-price failure was reproduced before the
row was added. The prior diagnostic keeps its original snapshot and missing
cost result; the changed snapshot applies only to a new registered execution.
