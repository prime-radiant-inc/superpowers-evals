# Coding-agent token capture for gemini / opencode / antigravity

**Date:** 2026-06-15
**Symptom:** live runs of gemini, opencode, and antigravity (agy) come back with
`economics.coding_agent: null` and `economics.partial: true`, while
claude/copilot/codex are fully priced.

## Investigation (read-only, against real passing runs)

The capture pipeline is correct end to end: `captureTokenUsage`
(`src/capture/index.ts`) finds the right new session logs, filters by cwd, and
calls `estimateSessionLogs(<normalizer>, <logs>)` (`src/obol/index.ts`). For all
three agents that call returned `null`, so no `coding-agent-token-usage.json` was
written → `coding_agent: null` → `partial: true`. `trajectory.json` was present
for all three, proving the logs WERE found and normalized to tool-call rows.

Probing obol directly (`estimatePath(log, dialect)`) on the real logs:

| agent | log location (under `coding-agent-config/`) | tokens IN the log? | obol result | root cause |
|---|---|---|---|---|
| gemini | `.gemini/tmp/**/chats/*.jsonl` | YES — per assistant turn: `tokens{input,output,cached,thoughts,tool,total}` + `model` (`gemini-3.5-flash`) | `per_model: []`, all-zero tokens → merge → null | obol `gemini` dialect cannot parse this gemini-cli version's per-turn JSONL shape |
| opencode | `.quorum/session-exports/*-ses_*.json` | YES — `messages[].info.tokens{input,output,reasoning,cache{read,write}}` + `modelID`/`providerID` (`gpt-5.5`/`openai`); opencode even pre-computes per-message `cost` | `per_model: []`, all-zero tokens → merge → null | obol `opencode` dialect cannot parse this opencode version's session-export shape |
| antigravity | `.gemini/antigravity-cli/brain/<uuid>/.system_generated/logs/transcript{,_full}.jsonl` | **NO** — grep over the entire run config tree finds token/usage fields ONLY in the gauntlet-agent's own `usage.jsonl`; agy writes no coding-agent usage anywhere | n/a — obol 0.4.1 has no `antigravity` dialect (`DIALECTS` map, `src/obol/index.ts`) so `estimateSessionLogs` returns null before calling obol | agy emits no token usage AND obol cannot price it |

obol is a closed native FFI library (Rust → `.dylib`); its dialect parsers are
not introspectable or patchable from this repo. This degradation is the path the
obol-migration design explicitly called out: "Backends whose logs Obol cannot
parse degrade exactly as today (`usage = None`, `partial: true`)" — and
"Verifying that gemini/copilot/pi session logs match Obol's dialects" was OUT OF
SCOPE there (`docs/superpowers/specs/2026-06-09-quorum-obol-migration-design.md`).

## Fix — quorum-side token math (gemini, opencode)

Per Jesse's directive ("ignore python parity in favor of making good, working
software"; "prefer actually capturing the real coding-agent tokens"), and
mirroring the existing kimi `tool_result_total_bytes` precedent (quorum-side
computation layered onto obol):

- `src/obol/fallback.ts` `sumCodingAgentTokens(family, files)` reads the agent's
  OWN per-message usage straight from its logs:
  - **gemini**: sum `type:"gemini"` JSONL rows, deduplicated by row `id` (gemini
    writes a turn twice — once before, once after tool calls — sharing the id, so
    dedup is mandatory or every turn double-counts); fold `thoughts` into output;
    `cached` → cache_read; provider `google`.
  - **opencode**: sum assistant `messages[].info.tokens`; fold `reasoning` into
    output; `cache.read`/`cache.write` → cache_read/cache_create; model/provider
    from `modelID`/`providerID`.
  - Every model is marked **unpriced** (`est_cost_usd: null`,
    `unpriced_models: [model]`): we count the real tokens, we do not invent a
    price obol could not compute.
- `estimateSessionLogs` (`src/obol/index.ts`) now uses obol first and falls back
  to `sumCodingAgentTokens` only when obol returns null.

### Result (verified against the real logs)

- gemini: `coding_agent` carries `33969` tokens, `model: gemini-3.5-flash`.
- opencode: `coding_agent` carries `29131` tokens, `model: gpt-5.5`.
- Both: `est_cost_usd: null`, `has_unpriced_model: true` → `partial` stays `true`
  HONESTLY (tokens captured, cost genuinely unknown to obol).
- antigravity: still `coding_agent: null` — correct; there is nothing to capture.

## antigravity — limitation + proposed path

agy does not write coding-agent token usage. To price/count agy tokens we need
ONE of:
1. agy itself emitting a usage record (upstream change — out of our control), or
2. a usage-bearing sidecar at launch (e.g. wrap agy / read its backend's usage
   response), then a `sumCodingAgentTokens('antigravity', …)` summer over it, or
3. an obol `antigravity` dialect (obol-repo change).

Until one exists, `coding_agent: null` / `partial: true` is the honest outcome.
Do NOT fabricate agy token counts.

## Tests

`test/obol-fallback.test.ts` — fixtures derived from the real gemini-cli and
opencode session-log shapes (2026-06-15): gemini dedup-by-id sum, opencode
per-assistant-message sum, unpriced-model invariants, no-summer families
(claude/antigravity) → null, no-usage logs → null, and the
`estimateSessionLogs` obol→fallback wiring.
