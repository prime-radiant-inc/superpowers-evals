# ATIF normalizers — per-format mapping & assumptions (evergreen)

Each Coding-Agent writes a different session-log format; `src/normalize/<agent>.ts` converts it to the canonical ATIF `trajectory.json` (`src/atif/types.ts`). This is the living reference for **what each converter does and the assumptions it bakes in** — update it whenever a normalizer or an agent's log format changes. (Token-usage capture was added 2026-06-15; see spec `docs/superpowers/specs/2026-06-15-atif-usage-unification.md`.)

## Shared conventions (all normalizers)

- **Tool calls / skills** → `step.tool_calls` / `step.observation` (drives `check-transcript`).
- **Full-fidelity content (added this branch):** normalizers now emit content where the source log carries it: `step.message` (agent/user text), `step.reasoning_content` (thinking/reasoning blocks), `step.observation` (tool outputs, with `source_call_id` matching the same step's tool_call), plus `trajectory.session_id`, `agent.version`, and `agent.extra` where present in the log.
- **Subagent-dispatch prompt → canonical `prompt` arg.** ATIF `arguments` is free-form (Harbor RFC 0001 blesses no dispatch key), so we set the convention: each normalizer aliases its subagent tool to `Agent`, and the dispatch instruction is canonicalized to the `prompt` key — so cross-harness checks (`tool-arg-match Agent --matches prompt=…`) are portable instead of silently failing where the key differs. claude/gemini/antigravity/copilot/opencode/kimi emit `prompt` natively; codex (`spawn_agent`) and pi (`subagent`) emit `task`, rewritten to `prompt` by `src/normalize/agent-prompt.ts` (lossless — the raw key survives in the retained session log). **kimi's orchestrator session emits `Agent` tool calls natively** (verified: `main/wire.jsonl` carries 18 `Agent` calls with `description`/`subagent_type`/`prompt` args); no alias is needed. Note: kimi dispatches subagents via an internal mechanism — the subagent sessions (`agents/agent-*/wire.jsonl`) contain only Bash/Read/Write tool calls and no `Agent` call; the `Agent` tool calls exist only in the main orchestrator session. An `Agent` transcript check is therefore satisfiable on kimi (via the main session log), but will never match a step in a subagent-session log.
- **Token usage → ATIF metrics.** Per assistant/turn: `step.metrics` + `step.model_name`. Session-total-only logs: `trajectory.final_metrics` + `agent.model_name`.
- **Buckets are DISJOINT** (no overlap), so they sum cleanly and map 1:1 to obol's `{input, cache_read, cache_write, output}`:
  - `metrics.prompt_tokens` = **UNCACHED** input
  - `metrics.cached_tokens` = cache-read
  - `step.extra.cache_write` = cache-creation/write (only when > 0)
  - `metrics.completion_tokens` = output **+ reasoning/thoughts/thinking folded in**
  - `metrics.cost_usd` = per-message cost **only when the log records one** (else unset → priced downstream)
- **`metrics`/`model_name` are ATIF agent-step fields** (enforced by `validate.ts`). When no tool-call step carries the usage (text-only turn, or a running-snapshot's first frame), the normalizer emits a dedicated **metrics-only `agent` step**. Therefore **downstream summing (the obol `atif` dialect / economics) MUST sum `metrics` across ALL steps**, not just tool-call steps.
- **SINGLE-SOURCE invariant (load-bearing):** each agent reports usage in EXACTLY ONE place — either **all per-step `step.metrics`** OR **all `final_metrics`**, never a hybrid. The obol `atif` dialect **skips `final_metrics` whenever any step carries metrics** (to avoid double-counting a rollup), so a hybrid (e.g. completion per-step + prompt/cached in `final_metrics`) would silently drop the `final_metrics` buckets. copilot was such a hybrid and is now final_metrics-only.
- **`final_metrics` has no cached field** → cached rides in `final_metrics.extra.total_cached_tokens`.
- **provider** (when the log has one) → `step.extra.provider`.
- Cost is **never fabricated**: no usage in the log → no metrics → null cost.

## How to write a normalizer

A normalizer is `src/normalize/<agent>.ts` exporting `normalize<Agent>(raw: string, version: string): AtifTrajectory` — the agent's raw session-log text plus the harness-supplied agent-version string in, a validated ATIF `Trajectory` out (`src/atif/types.ts`, `validate.ts`; the `AtifNormalizer` type in `src/capture/index.ts`). There are two ways to get one:

- **Port an existing Harbor converter** (the agent ships in Harbor's `installed/<agent>`): follow `porting-harbor-converters.md`. That doc owns the port recipe, the pin/sync machinery, and the inclusive→disjoint + native→canonical translations. Return here for the conventions every normalizer must satisfy (above) and to add the per-agent row (below).
- **Reverse-engineer from a real captured log** (the agent has NO Harbor converter — e.g. pi, droid, grok): use the recipe below.

### Recipe: reverse-engineer from a real log

1. **Get a real log.** Run the agent once in evals (or find a captured run) and open its raw session log under the run's throwaway `$HOME` — the path `coding-agents/<agent>.yaml`'s `session_log_dir`/`session_log_glob` point at. You CANNOT work from `trajectory.json`; that is the normalizer's *output*. You need the agent's own log, which carries the content the normalizer must learn to extract. (Worked example — pi: `results/sdd-go-fractals-elicited-pi-*/home/.pi/agent/sessions/**/*.jsonl`.)
2. **Map the log's shape before writing code.** Histogram the entry types; for each, locate: assistant/user text, reasoning/thinking, tool calls + their results (and the id that links a result to its call), the token `usage` block (and whether it is per-message/turn or session-total), how the model is attributed (a per-message field vs. a separate `model_change`-style entry you must track *forward* across later messages), the session id, and how subagents appear. **Extract only fields the log actually carries — never fabricate.**
3. **Pick the usage scope → SINGLE-SOURCE.** Per-message/turn usage → per-step `step.metrics` (+ `step.model_name`). Session-total-only → `trajectory.final_metrics` (+ `agent.model_name`). Never both — see the single-source invariant above.
4. **Map tokens to the DISJOINT buckets** (above): uncached prompt / cached / cache_write (on `step.extra.cache_write`) / completion (reasoning folded in). Verify conservation against the log (`prompt + cached + completion == total`).
5. **Content (full fidelity).** Emit `step.message`, `step.reasoning_content`, and `step.observation` (linked to its call via `source_call_id`) for whatever the log carries; set `trajectory.session_id`, `agent.version`, `agent.extra` when present. Model an existing full-fidelity normalizer — `claude.ts`, `opencode.ts`, or `pi.ts`.
6. **Canonical tools + subagent alias.** Build an `<AGENT>_TOOL_MAP` (native→canonical) and route the subagent-spawn tool through `agent-prompt.ts` (alias to `Agent`, dispatch instruction → the `prompt` key). **Verify the spawn tool's real name and shape against the log — do NOT assume.** pi's is literally `subagent` (and its `action:"list"` management call must stay `subagent`); kimi emits `Agent` natively. Getting this wrong silently breaks the portable `tool-arg-match Agent --matches prompt=…` checks.
7. **Stamp + validate.** Set `ATIF_SCHEMA_VERSION`; call `validateTrajectory`.
8. **Register it.** Add `normalize<Agent>` to the `NORMALIZERS` map in `src/capture/index.ts`. For agents that share a `$HOME` tree (codex/pi/kimi), wire its cwd-filter (`src/capture/cwd-filter.ts`) so concurrent sessions in one home don't cross-contaminate.

### TDD + the obol verification (do NOT skip)

- Write the test FIRST against a small fixture sliced from the REAL log (a handful of entries covering text, reasoning, a tool call + its result, a usage block, and the model/session entries). RED → implement → GREEN. Keep existing tests; don't weaken them to pass.
- **Token-conservation unit tests are necessary but NOT sufficient — they never catch a pricing bug.** Before committing, price the produced trajectory through obol's `atif` dialect and confirm a **NON-$0** cost when the log carries cost (or correct rate-table pricing when it doesn't). Every cost bug in the porting wave (cursor priced $0, cache_write on the wrong field, mini-swe cost discarded) passed the unit tests and surfaced only when priced. The obol rules that bite:
  - obol prices ONLY per-step `step.metrics` buckets + `step.extra.cache_write` + per-step `step.metrics.cost_usd`, **keyed by `model_name`**. A missing/empty `model_name` → priced **$0**.
  - `step.metrics.extra.cache_write` and `final_metrics.*` (whenever any step carries metrics) are **IGNORED**. Cache-write MUST live on `step.extra.cache_write`; per-step cost MUST live on `step.metrics.cost_usd`.
- Gates: `bun run check` (biome + tsc + bun test) and `bun run quorum check` green.
- **Update this doc:** add the agent's row under "Per-agent" (log path, bucket mapping, quirks, full-fidelity fields). This reference is only useful while it stays current.

## Per-agent

### claude (`normalize/claude.ts`) — per-step, disjoint
- Log: claude session `**/*.jsonl`; assistant rows carry `message.usage` + `message.model`.
- `usage.input_tokens`→prompt; `output_tokens`→completion; `cache_read_input_tokens`→cached; `cache_creation_input_tokens`→`extra.cache_write`; `message.model`→model_name.
- **Disjoint already** (input excludes cache_read). No cost logged.
- **Full-fidelity:** emits `step.message` (text blocks), `step.reasoning_content` (thinking/reasoning/analysis blocks), `step.observation` (tool_result blocks with stdout/stderr/exitCode formatting), `trajectory.session_id` (from `sessionId` field on log rows), `agent.version` (from `version` field), `agent.extra` (cwds/git_branches/agent_ids).

### codex (`normalize/codex.ts`) — session-total → final_metrics; **input INCLUDES cached**
- Log: `rollout-*.jsonl`; usage rides `event_msg` rows `payload.type=="token_count"`, `info.total_token_usage` is the running cumulative (last = session total). Rollout steps are individual tool calls with no turn/message structure, so usage maps to **`final_metrics`**, not per-step. Model from `turn_context.payload.model`.
- **ASSUMPTION/QUIRK:** codex `input_tokens` INCLUDES cached (`total_tokens == input_tokens + output_tokens`, cached ⊂ input). So `total_prompt_tokens = input_tokens − cached_input_tokens` (the disjoint correction); `cached_input_tokens`→`final_metrics.extra.total_cached_tokens`. **`output_tokens` ALREADY INCLUDES `reasoning_output_tokens`** (verified against real rollouts: `total_tokens == input + output` in every row, with `reasoning ⊆ output`), so `total_completion_tokens = output_tokens` — do NOT add reasoning again or you double-count it. Conservation: `prompt + cached + completion == total_tokens`. No cost logged.
- **Full-fidelity:** emits `step.message` (message events), `step.reasoning_content` (reasoning events with non-empty summary), `step.observation` (function_call_output/custom_tool_call_output paired by call_id), `trajectory.session_id` + `agent.version` + `agent.extra` (from session_meta). `web_search_call` → canonical `WebSearch` tool call.

### gemini (`normalize/gemini.ts`) — per-turn, disjoint, **running-snapshot dedup**
- Log: `chats/session-*.jsonl`; `type:"gemini"` rows carry `tokens{input,output,cached,thoughts,tool,total}` + `model`.
- `input`→prompt; `output`+`thoughts`+`tool`→completion; `cached`→cached; `model`→model_name; provider stamped `"google"` (gemini logs none). No cost logged.
- **Disjoint** (verified: `total == input+output+thoughts+tool+cached`). Note: `tool` tokens are real output tokens (tool-call generation) previously dropped; they are now folded into completion.
- **QUIRK:** gemini-cli rewrites a running `messages[]` snapshot each line, so the same turn (same row `id`) recurs (once without tool calls, once with) with identical tokens. Dedup by row `id` — count each turn's tokens **once**, on the first step emitted for that id (often a metrics-only step).
- **Full-fidelity:** emits `step.message` (model text), `step.reasoning_content` (thought text), `step.observation` (tool responses), `trajectory.session_id` + `agent.version` (from log metadata).

### opencode (`normalize/opencode.ts`) — per-message, disjoint, **carries cost**
- Log: `.quorum/session-exports/*.json`; `messages[].info.tokens{input,output,reasoning,cache{read,write}}` + `modelID` + `providerID` + per-message `cost`.
- `input`→prompt; `output`+`reasoning`→completion; `cache.read`→cached; `cache.write`→`extra.cache_write`; `modelID`→model_name; `providerID`→`extra.provider`; **`cost`→`cost_usd` (NOT re-priced).**
- **Disjoint** (input separate from cache.read).
- **Full-fidelity:** emits `step.message` (assistant text), `step.reasoning_content` (reasoning blocks), `step.observation` (tool results with `source_call_id`), `trajectory.session_id` + `agent.version` (from session metadata).

### pi (`normalize/pi.ts`) — per-message, disjoint, **carries cost**
- Log: pi session `.pi/agent/sessions/**/*.jsonl`. `type:"message"` rows carry `usage{input,output,cacheRead,cacheWrite,cost{total},totalTokens}`; the model arrives in a SEPARATE `type:"model_change"` entry (`provider`+`modelId`, e.g. `openai-codex`/`gpt-5.5`) tracked FORWARD to subsequent messages; `type:"session"` carries the session id.
- `input`→prompt; `output`→completion; `cacheRead`→cached; `cacheWrite`→`extra.cache_write`; **`cost.total`→ per-step `cost_usd`** (unrounded passthrough — float noise from the log); tracked `modelId`→model_name; `provider`→`extra.provider`.
- **Disjoint** (verified: `input+output+cacheRead == totalTokens`). Usage attaches to the message's first toolCall step, or a metrics-only step for a usage-bearing text-only message.
- **Subagent:** pi's spawn tool is literally named `subagent`. Execution calls (carrying `agent`+`task`, no `action`) alias to canonical `Agent` with `task`→`prompt`; the management call (`action:"list"`) stays `subagent`. Verified against the real log — do not assume the name.
- **Full-fidelity:** emits `step.message` (assistant text), `step.reasoning_content` (pi's `thinking` blocks — plain text), `step.observation` (tool results linked by `source_call_id`), `trajectory.session_id` (from the `session` entry). `agent.version` is the harness-supplied version string (pi's log header is not parsed for it); `agent.extra` is not emitted.

### copilot (`normalize/copilot.ts`) — **final_metrics-only** (single source)
- Log: copilot session-state events. Copilot reports the full usage ONLY at `session.shutdown.tokenDetails`: `input.tokenCount`→`final_metrics.total_prompt_tokens`, `output.tokenCount`→`final_metrics.total_completion_tokens`, `cache_read.tokenCount`→`final_metrics.extra.total_cached_tokens`, `currentModel`→`agent.model_name`. Tool steps carry tool_calls but **no `metrics`**.
- **Final_metrics-only because of the SINGLE-SOURCE invariant** above: an earlier hybrid (completion per-step + prompt/cached in final_metrics) made the obol `atif` dialect skip final_metrics and silently drop ~90K of prompt+cached (the `copilot at 1k` bug). The shutdown `output` total equals the sum of per-message `outputTokens`, so sourcing completion from the shutdown total loses nothing.
- **Disjoint** (verified: `modelMetrics.inputTokens == tokenDetails.input + cacheReadTokens`; use `tokenDetails.input` as the uncached prompt). Conservation: `final prompt + final completion + final cached == session total`. No per-message cost → priced downstream.
- **Full-fidelity:** emits `step.message` (assistant text), `step.observation` (tool results), `agent.version` + `trajectory.session_id` (from session header). Reasoning: copilot reasoning is encrypted/absent in logs — `step.reasoning_content` is not emitted.

### kimi (`normalize/kimi.ts`) — per-turn, disjoint, **turn-vs-session scope**
- Log: `wire.jsonl`; `type:"usage.record"` rows, `usage{inputOther,inputCacheRead,inputCacheCreation,output}` + `model` (verbatim, e.g. `kimi-code/kimi-for-coding`).
- `inputOther`→prompt (already uncached); `inputCacheRead`→cached; `inputCacheCreation`→`extra.cache_write`; `output`→completion; `model`→model_name. No cost (model may be obol-unpriced — honest).
- **QUIRK:** rows have `usageScope` of BOTH `"turn"` and `"session"`. Prefer per-turn rows (drop session-scope to avoid double-counting); if only session totals exist, fold into `final_metrics`. Usage rides dedicated agent steps; all-zero-token rows dropped. (`kimiLogsHaveSuperpowersSessionStart` is a separate capture-time assertion — leave intact.)
- **Full-fidelity:** emits `step.message` (assistant text), `step.reasoning_content` (thinking blocks), `step.observation` (tool results from `tool.result` events, with `source_call_id`), `trajectory.session_id` + `agent.version` (from session metadata). No reasoning encryption — kimi thinking blocks are plain text.

### antigravity (`normalize/antigravity.ts`) — **no usage emitted**
- Log: `brain/<uuid>/.system_generated/logs/transcript.jsonl`. agy emits **no coding-agent token usage anywhere** (only the gauntlet-agent's own `usage.jsonl` has tokens). The normalizer leaves `metrics`/`final_metrics` UNSET; cost is null — honest, not fabricated. A guard test asserts no metrics. Closing this needs an upstream fix (agy emitting usage); see `docs/experiments/2026-06-15-coding-agent-token-capture.md`.
- **Full-fidelity:** emits `step.message` (content blocks) and `step.reasoning_content` (thinking blocks — plain text, not encrypted). No tokens → no metrics. `agent.version` + `agent.extra` from session header where present.

## Downstream
Economics reads these ATIF metrics (not raw logs) and prices via obol's **`atif` dialect**: disjoint buckets → obol `{input, cache_read, cache_write, output}` rates; an embedded `cost_usd`/`total_cost_usd` is used verbatim (not re-priced). See the unification spec for the retirement of the old per-agent obol log parsers + `src/obol/fallback.ts`.
