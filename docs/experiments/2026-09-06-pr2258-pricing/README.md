# PR 2258 five-model campaign pricing

An experiment-specific obol 0.9.0 snapshot, in USD per million tokens, for
the five subject models, the Codex delegate models observed in the pilot,
the fixed grader, and the Claude Code subagent model that may appear in
Claude trajectories. It supersedes the 2026-09-04 pilot snapshot for this
campaign; that file is unchanged. It contains only explicitly priced model
ids; an unexpected model is unpriced and shows up as a non-empty
`unpriced_models` list on the attempt's captured usage.

Sources checked 2026-09-06:

- OpenAI rows are copied from the pilot snapshot (OpenAI Standard pricing,
  checked 2026-09-04), including the 272,000-token long-context tier.
- Anthropic rows are from the Anthropic pricing page read 2026-09-06: Opus 5
  and Opus 4.8 at $5 input, $25 output, $0.50 cache read, $6.25 five-minute
  cache write, $10 one-hour cache write; Sonnet 5 at $2 / $10 / $0.20 /
  $2.50 / $4 (the introductory price is now standard); Haiku 4.5 at $1 /
  $5 / $0.10 / $1.25 / $2. Both the bare and `anthropic.`-prefixed ids are
  listed because Mantle requests use the prefixed id while responses and
  Claude Code logs may report the bare id.

Bundled obol 0.9.0 (as_of 2026-08-05) leaves `gpt-6-astra` unpriced and
prices `gpt-5.6-sol` at $10 / $30, which OpenAI no longer charges. A campaign
snapshot replaces the whole table, so every model the campaign can touch
must be here.

This is a **Standard / global** estimate, not an invoice. The Anthropic page
states Bedrock global endpoints use standard pricing and regional endpoints
carry a 10% premium; Mantle is in-region (us-east-1), so Claude subject and
grader costs here may be understated by up to 10%. Carry that sensitivity in
the ledger. Fast mode, separate tool fees, discounts, and unlogged calls are
outside this table.

## Offline probe

From the evals checkout:

```sh
OBOL_PRICING_DIR="$PWD/docs/experiments/2026-09-06-pr2258-pricing" \
  bun run docs/experiments/2026-09-06-pr2258-pricing/verify.ts
```

The probe calls the real Quorum subject and grader capture functions and the
native obol library. It checks the OpenAI long-context boundary, every
Anthropic row, all grader cache buckets, and null cost for an unknown model.
Without `OBOL_PRICING_DIR` it fails on `gpt-6-astra: unpriced`, which is the
proof the snapshot is load-bearing.

The suite declares this file as `pricing_snapshot` with its SHA-256;
registration freezes the identity and worker preparation verifies the bytes
before any credential is created.
