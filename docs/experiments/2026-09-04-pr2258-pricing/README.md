# PR 2258 pilot pricing

This is an experiment-specific obol 0.9.0 snapshot, in USD per million tokens,
for the two subjects, their known native delegate models, and the fixed grader.
It contains only explicitly priced model IDs. An unexpected model is unpriced
and requires an accounting review before another pilot job is admitted.
Require an empty `unpriced_models` list for both subject and grader. A mixed
known/unknown trajectory can have a numeric subtotal while omitting the
unknown model's cost; a non-null total alone does not prove full coverage.

Sources checked September 4, 2026:

- [OpenAI Standard pricing](https://developers.openai.com/api/docs/pricing):
  Astra, Sol, Terra, and Luna input, cache-read, cache-write, and output rates.
  The [Astra model notes](https://developers.openai.com/api/docs/models/gpt-6-astra)
  give the 272,000 input-token threshold: above it, the entire request uses
  twice the input/cache rates and 1.5 times the output rate.
- [AWS Bedrock pricing](https://aws.amazon.com/bedrock/pricing/), rendered
  Anthropic / Global Cross-region Inference table: Sonnet 5 costs $2 input,
  $10 output, $2.50 five-minute cache-write, $4 one-hour cache-write, and
  $0.20 cache-read. Both the requested prefixed ID and returned bare ID are
  included. These agree with [Anthropic's current price table](https://platform.claude.com/docs/en/about-claude/pricing).

This is a **Standard/global token estimate**, not an invoice. Verify served
model, service tier, geography, and token accounting in the first pair. A
regional Bedrock rate may carry a 10% premium; include that sensitivity in
the budget ledger until the delivered route is established. Fast processing,
separate tool fees, discounts, and unlogged calls are outside this table.
Do not silently price non-Standard calls with it. Drew approved a $500 total
campaign allowance, including prior attempts; the experiment log and private
ledger retain the admission reserves and observed spending.

The OpenAI cache-write rates are represented, but the current Codex ATIF
capture does not establish explicit cache-write coverage. Review raw usage
before accepting cost comparisons if those buckets appear. Grader sidecars
retain separate five-minute and one-hour cache-write counts.

## Offline probe

From the evals checkout:

```sh
OBOL_PRICING_DIR="$PWD/docs/experiments/2026-09-04-pr2258-pricing" \
  bun run docs/experiments/2026-09-04-pr2258-pricing/verify.ts
```

The probe calls the real Quorum subject/grader capture functions and native
obol library. It checks short requests, the exact long-context boundary and
one token above it, all grader cache buckets, and null cost for an unknown
model. It deliberately does not set pricing internally, so the same command
without OBOL_PRICING_DIR validates deployment through the process's default
home. It initially failed on bundled pricing because Astra was unpriced;
all 15 probes passed with this snapshot.

Snapshot SHA256:
`f1d4981ba73a6e69d3fafcd6c9f3eaacd3b38fb4f1e0987f2b4f720713642b81`.

For the appliance, use the existing container home's
`.local/share/obol/current.json` while the pilot owns the appliance. Save and
restore any previous file under the helper's run/sync mutation locks. Validate
the installed file's digest, then run the probe **without** an override in the
same container environment used for capture. Recheck before each job and
preserve the table with the results. Never install this narrow table globally
for unrelated work or overwrite previously captured costs.
