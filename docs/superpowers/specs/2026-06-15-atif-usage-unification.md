# Spec: Unify token/cost on ATIF — normalizers fill usage, obol prices ATIF

> Status: spec → implement (2026-06-15). Finishes the ATIF graft: the **transcript** moved to ATIF, but **economics** still re-parses raw per-agent logs through obol's per-dialect parsers (+ a bolted-on fallback). This makes ATIF the single source for usage, and makes obol able to price an ATIF trajectory directly.

## Problem
The normalizers already read every agent's raw session log to build `trajectory.json`, but they **drop** the token usage that's in those logs. `AtifStep.metrics` / `AtifTrajectory.final_metrics` exist in the type but **nothing populates or reads them**. Economics instead calls `obol.estimatePath(rawLog, <agent dialect>)`, whose per-agent parsers drift with log-format changes (gemini/opencode returned zero → `src/obol/fallback.ts` was bolted on). Two parsers over the same logs; the ATIF usage fields sit empty.

## Pricing rule (Jesse)
Cost comes from the transcript when the agent logged it; obol's rate tables are the fallback ONLY when the transcript has no cost:
- transcript has a per-message **cost** (opencode `cost`, pi `usage.cost`) → that's the cost; do NOT re-price.
- transcript has **tokens but no cost** → price the tokens with obol's rate tables (rates aren't missing in obol).
- transcript has **neither** (antigravity) → cost is null. Honest, not fabricated.

## Decision: ATIF-native obol (the "in-evals bridge" is rejected)
obol gains an **`"atif"` dialect**: `estimatePath(trajectory.json, "atif")` reads ATIF directly, honors embedded `cost_usd`, else prices tokens by its rate table. `src/economics.ts` then just calls that. obol becomes the one authority that prices an ATIF trajectory (reusable beyond evals).

## The contract (all sides build to this)
**`AtifStep.metrics`** = `{ prompt_tokens, completion_tokens, cached_tokens, cost_usd? }`; **`AtifStep.model_name`**; provider (if logged) in **`AtifStep.extra.provider`**; cache-write (if logged) in **`AtifStep.extra.cache_write`**. Session-total-only logs → **`AtifTrajectory.final_metrics`** (`total_prompt_tokens`/`total_completion_tokens`/`total_cost_usd?`) + `agent.model_name`.

Field mapping for the normalizers: input/prompt→`prompt_tokens`; output/completion→`completion_tokens`; cache-read→`cached_tokens`; reasoning/thoughts/thinking folded into `completion_tokens`; per-message cost→`cost_usd`. De-dupe per the log's semantics (gemini rewrites a running `messages[]` snapshot — sum distinct message ids, not every snapshot).

ATIF shape (from `src/atif/types.ts`): `AtifTrajectory{ schema_version:"ATIF-v1.7", agent{name,version,model_name?}, steps[]{step_id,source,model_name?,metrics?{prompt_tokens?,completion_tokens?,cached_tokens?,cost_usd?},extra?}, final_metrics?{total_prompt_tokens?,total_completion_tokens?,total_cost_usd?} }`.

## Workstreams (max parallelism, strict TDD, disjoint files; no legacy left behind)

### Phase 1 (parallel)
- **8 normalizer agents** — `src/normalize/<agent>.ts` + `test/normalize.<agent>.test.ts`, one each: claude, codex, gemini, copilot, opencode, pi, kimi, antigravity. Each fills `step.metrics`/`final_metrics` per the contract from that agent's real log shape (fixtures derived from the live runs in `results/` + `/tmp/quorum-live-results*`). Log token locations (from the capture root-cause): gemini `chats/session-*.jsonl` rows `type:"gemini"` `tokens{input,output,cached,thoughts,tool,total}`+`model`; opencode `.quorum/session-exports/*.json` `messages[].info.tokens{input,output,reasoning,cache{read,write}}`+`modelID`/`providerID`+ per-message `cost`; kimi `wire.jsonl`/usage.record (`kimi-for-coding`); codex rollout token-count events; claude/copilot/pi from their existing message usage. antigravity = none (assert metrics stay empty).
- **1 obol `atif`-dialect agent** — in the obol repo `/Users/jesse/git/prime-radiant-inc/obol` (own branch): add `obol-core/src/transcript/atif.rs` parsing `trajectory.json` per the ATIF shape above + the pricing rule, register the `"atif"` Dialect (Rust + `obol-ffi` + the TS binding's `Dialect` union), Rust + binding tests with a fixture trajectory, and produce a **locally-consumable build** of the npm binding (report the exact version/path so evals can install it). obol's existing rate tables do the pricing.

### Phase 2 (after the obol binding is consumable + normalizers merged)
- **1 economics agent** — `src/economics.ts`, `src/capture/index.ts`, `src/obol/index.ts`: bump `@primeradianthq/obol` to the new build; call `estimatePath(trajectory.json, "atif")`; **delete** `src/obol/fallback.ts` + its test; remove the per-agent-dialect raw-log path in `estimateSessionLogs`/`captureTokenUsage` and the `DIALECTS` map (shrink to nothing/`"atif"`); drop `coding-agent-token-usage.json`-from-raw-logs unless a live consumer needs it. TDD against fixture `trajectory.json` files carrying `metrics`.

Controller (me): merge Phase 1, then Phase 2, re-gate, then **live-verify** every agent (`quorum run … --out-root /tmp/…`, serf `.env` sourced inline, never echoed) shows real coding tokens + a price (or honest unpriced) via `quorum costs`.

## Retire (grep-verify nothing left)
`src/obol/fallback.ts` gone; no code reads a raw agent log for tokens; `estimatePath` called only with `"atif"`; `DIALECTS` per-agent map gone. A real obol publish + final dep-bump is an explicit last step with Jesse (Phase 1 uses a local build).

## Acceptance
- `quorum costs` shows real coding tokens for every agent whose log carries usage (all but antigravity), priced where obol has a rate or where the transcript embedded a cost; antigravity null.
- `estimatePath` only ever called with `"atif"`; `src/obol/fallback.ts` deleted; no raw-log token reader remains.
- `bun run check` + `bun run quorum check` green; obol's own Rust+binding tests green.
