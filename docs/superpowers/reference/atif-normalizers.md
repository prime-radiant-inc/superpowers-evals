# ATIF normalizers — per-format mapping & assumptions (evergreen)

Each Coding-Agent writes a different session-log format; `src/normalize/<agent>.ts` converts it to the canonical ATIF `trajectory.json` (`src/atif/types.ts`). This is the living reference for **what each converter does and the assumptions it bakes in** — update it whenever a normalizer or an agent's log format changes. (Token-usage capture was added 2026-06-15; see spec `docs/superpowers/specs/2026-06-15-atif-usage-unification.md`.)

## Shared conventions (all normalizers)

- **Tool calls / skills** → `step.tool_calls` / `step.observation` (drives `check-transcript`). Not covered further here.
- **Token usage → ATIF metrics.** Per assistant/turn: `step.metrics` + `step.model_name`. Session-total-only logs: `trajectory.final_metrics` + `agent.model_name`.
- **Buckets are DISJOINT** (no overlap), so they sum cleanly and map 1:1 to obol's `{input, cache_read, cache_write, output}`:
  - `metrics.prompt_tokens` = **UNCACHED** input
  - `metrics.cached_tokens` = cache-read
  - `step.extra.cache_write` = cache-creation/write (only when > 0)
  - `metrics.completion_tokens` = output **+ reasoning/thoughts/thinking folded in**
  - `metrics.cost_usd` = per-message cost **only when the log records one** (else unset → priced downstream)
- **`metrics`/`model_name` are ATIF agent-step fields** (enforced by `validate.ts`). When no tool-call step carries the usage (text-only turn, or a running-snapshot's first frame), the normalizer emits a dedicated **metrics-only `agent` step**. Therefore **downstream summing (the obol `atif` dialect / economics) MUST sum `metrics` across ALL steps**, not just tool-call steps.
- **`final_metrics` has no cached field** → cached rides in `final_metrics.extra.total_cached_tokens`.
- **provider** (when the log has one) → `step.extra.provider`.
- Cost is **never fabricated**: no usage in the log → no metrics → null cost.

## Per-agent

### claude (`normalize/claude.ts`) — per-step, disjoint
- Log: claude session `**/*.jsonl`; assistant rows carry `message.usage` + `message.model`.
- `usage.input_tokens`→prompt; `output_tokens`→completion; `cache_read_input_tokens`→cached; `cache_creation_input_tokens`→`extra.cache_write`; `message.model`→model_name.
- **Disjoint already** (input excludes cache_read). No cost logged.

### codex (`normalize/codex.ts`) — session-total → final_metrics; **input INCLUDES cached**
- Log: `rollout-*.jsonl`; usage rides `event_msg` rows `payload.type=="token_count"`, `info.total_token_usage` is the running cumulative (last = session total). Rollout steps are individual tool calls with no turn/message structure, so usage maps to **`final_metrics`**, not per-step. Model from `turn_context.payload.model`.
- **ASSUMPTION/QUIRK:** codex `input_tokens` INCLUDES cached (`total_tokens == input_tokens + output_tokens`, cached ⊂ input). So `total_prompt_tokens = input_tokens − cached_input_tokens` (the disjoint correction); `cached_input_tokens`→`final_metrics.extra.total_cached_tokens`. **`output_tokens` ALREADY INCLUDES `reasoning_output_tokens`** (verified against real rollouts: `total_tokens == input + output` in every row, with `reasoning ⊆ output`), so `total_completion_tokens = output_tokens` — do NOT add reasoning again or you double-count it. Conservation: `prompt + cached + completion == total_tokens`. No cost logged.

### gemini (`normalize/gemini.ts`) — per-turn, disjoint, **running-snapshot dedup**
- Log: `chats/session-*.jsonl`; `type:"gemini"` rows carry `tokens{input,output,cached,thoughts,tool,total}` + `model`.
- `input`→prompt; `output`+`thoughts`→completion; `cached`→cached; `model`→model_name; provider stamped `"google"` (gemini logs none). No cost logged.
- **Disjoint** (verified: `total == input+output+thoughts+cached`).
- **QUIRK:** gemini-cli rewrites a running `messages[]` snapshot each line, so the same turn (same row `id`) recurs (once without tool calls, once with) with identical tokens. Dedup by row `id` — count each turn's tokens **once**, on the first step emitted for that id (often a metrics-only step).

### opencode (`normalize/opencode.ts`) — per-message, disjoint, **carries cost**
- Log: `.quorum/session-exports/*.json`; `messages[].info.tokens{input,output,reasoning,cache{read,write}}` + `modelID` + `providerID` + per-message `cost`.
- `input`→prompt; `output`+`reasoning`→completion; `cache.read`→cached; `cache.write`→`extra.cache_write`; `modelID`→model_name; `providerID`→`extra.provider`; **`cost`→`cost_usd` (NOT re-priced).**
- **Disjoint** (input separate from cache.read).

### pi (`normalize/pi.ts`) — per-message, disjoint, **carries cost**
- Log: pi session; `message.usage{input,output,cacheRead,cacheWrite,cost{total},totalTokens}` + `model` + `provider`.
- `input`→prompt; `output`→completion; `cacheRead`→cached; `cacheWrite`→`extra.cache_write`; **`cost.total`→`cost_usd`**; `model`→model_name; `provider`→`extra.provider`.
- **Disjoint** (verified: `input+output+cacheRead == totalTokens`). Usage attaches to the message's first toolCall step, or a metrics-only step for a usage-bearing text-only final message. Cost values are passed through unrounded (float noise from the log).

### copilot (`normalize/copilot.ts`) — **hybrid** per-step completion + session-total prompt/cached
- Log: copilot session-state events. Per `assistant.message`: `data.model`→model_name, `data.outputTokens`→completion (copilot logs NO per-message input/cache). Every assistant message carries `outputTokens`, including text-only turns (empty `toolRequests`); those ride a **metrics-only step** so their completion is not dropped. Session totals come ONLY for input from `session.shutdown.tokenDetails`: `input.tokenCount`→`final_metrics.total_prompt_tokens`, `cache_read.tokenCount`→`final_metrics.extra.total_cached_tokens`, `currentModel`→`agent.model_name`.
- **`total_completion_tokens` is NOT set on final_metrics** — completion is already accounted per-step. Carrying the shutdown `output.tokenCount` in final_metrics too would double-count completion when downstream sums `step.metrics` + `final_metrics` (the sum of per-step `outputTokens` equals the shutdown `output` total, verified against real logs).
- **Disjoint** (verified: `modelMetrics.inputTokens == tokenDetails.input + cacheReadTokens`; use `tokenDetails.input` as the uncached prompt). Conservation: `Σ(per-step completion) + final prompt + final cached == session total`. No per-message cost → priced downstream.

### kimi (`normalize/kimi.ts`) — per-turn, disjoint, **turn-vs-session scope**
- Log: `wire.jsonl`; `type:"usage.record"` rows, `usage{inputOther,inputCacheRead,inputCacheCreation,output}` + `model` (verbatim, e.g. `kimi-code/kimi-for-coding`).
- `inputOther`→prompt (already uncached); `inputCacheRead`→cached; `inputCacheCreation`→`extra.cache_write`; `output`→completion; `model`→model_name. No cost (model may be obol-unpriced — honest).
- **QUIRK:** rows have `usageScope` of BOTH `"turn"` and `"session"`. Prefer per-turn rows (drop session-scope to avoid double-counting); if only session totals exist, fold into `final_metrics`. Usage rides dedicated agent steps; all-zero-token rows dropped. (`kimiLogsHaveSuperpowersSessionStart` is a separate capture-time assertion — leave intact.)

### antigravity (`normalize/antigravity.ts`) — **no usage emitted**
- Log: `brain/<uuid>/.system_generated/logs/transcript.jsonl`. agy emits **no coding-agent token usage anywhere** (only the gauntlet-agent's own `usage.jsonl` has tokens). The normalizer leaves `metrics`/`final_metrics` UNSET; cost is null — honest, not fabricated. A guard test asserts no metrics. Closing this needs an upstream fix (agy emitting usage); see `docs/experiments/2026-06-15-coding-agent-token-capture.md`.

## Downstream
Economics reads these ATIF metrics (not raw logs) and prices via obol's **`atif` dialect**: disjoint buckets → obol `{input, cache_read, cache_write, output}` rates; an embedded `cost_usd`/`total_cost_usd` is used verbatim (not re-priced). See the unification spec for the retirement of the old per-agent obol log parsers + `src/obol/fallback.ts`.
