# quorum run economics — per-agent timing + cost in the report

**Linear:** PRI-1872
**Author:** Saga@eb3d1a89 (Opus 4.7)

---

## Goal

`quorum show`, `verdict.json`, and `run-all` should report **timing and cost for both agents**: the Gauntlet-Agent (the QA driver) and the Coding-Agent (the agent under test).

## Core constraint: compute at run time, freeze

Costs are computed **once, at run time**, and persisted into `verdict.json`. Pricing tables drift; a run's recorded dollar figure must reflect the pricing in effect when it ran — not whenever someone re-renders the report weeks later. Renderers (`show`, `run-all`) only display the frozen numbers; they never recompute. A `pricing_asof` marker is stamped into the persisted block so a stored cost stays interpretable.

The composer runs at the end of each run (it reads `result.json` to build the verdict), so computing economics there *is* run-time computation. This is why Approach A (compute in composer) is the right seam.

## What already exists

- **Coding-agent** tokens + `est_cost_usd` → `coding-agent-token-usage.json`, written at run time by `capture_token_usage` (`token_usage.py`; parses both Claude session JSONL and Codex rollout JSONL; sums across subagent session files). This dollar figure is already run-time-frozen.
- **Gauntlet-agent** tokens + `duration_ms` + model → `gauntlet-agent/results/<runId>/result.json`. Today the composer reads only `status`/`summary`/`reasoning` from it (`runner.py:_build_gauntlet_layer_from_run_dir`).
- `run-all` already tracks and prints per-run wall-clock `elapsed`.

## Verified log facts (not aspirational)

- Codex rollout JSONL: top-level `timestamp` (ISO-8601) on every line.
- Claude session JSONL: `timestamp` on `user`/`assistant`/`attachment` records; absent on metadata records (`mode`, `permission-mode`, `ai-title`, `file-history-snapshot`, `last-prompt`). Coding-agent duration must skip records lacking a timestamp.
- Gauntlet `result.json`: `duration_ms`, `usage.{inputTokens,outputTokens,cacheCreationInputTokens,cacheReadInputTokens,turns}`, `config.model`.

## Design (Approach A)

### 1. `quorum/economics.py` (new, pure)

```
build_run_economics(run_dir: Path) -> RunEconomics
```

`RunEconomics` (serialized into `verdict.json` under key `economics`):

```
{
  "pricing_asof": "2026-05",
  "gauntlet": {
    "duration_ms": int | null,
    "model": str | null,
    "tokens": {"input", "output", "cache_create", "cache_read", "total"},
    "est_cost_usd": float | null          # null when model unpriced
  } | null,
  "coding_agent": {
    "duration_ms": int | null,            # session-log span; null if no timestamps
    "model": str | null,
    "tokens": {...},
    "est_cost_usd": float | null
  } | null,
  "total_est_cost_usd": float | null,     # sum of the two when both present
  "partial": bool                          # true if a source was missing
}
```

- **Gauntlet block**: parse `gauntlet-agent/results/<runId>/result.json` → `duration_ms`, token breakdown from `usage`, `model` from `config.model`; compute `est_cost_usd` via the model→pricing resolver (see §2).
- **Coding-agent block**: read entirely from `coding-agent-token-usage.json` — tokens, frozen `est_cost_usd`, `model`, and (new) `duration_ms`. Economics does **not** re-open the session logs.
- **`total_est_cost_usd`**: sum the two `est_cost_usd` when both are non-null (independent token pools → summing is meaningful). If either is null, total is null and `partial=true`.
- **Timing does not sum**: the Coding-Agent runs inside the Gauntlet-Agent's wall-clock. Each agent's own duration is reported side by side; no total-time figure.

### 1a. Coding-agent duration — capture in `token_usage.py`

`token_usage.py`'s parsers (`parse_claude_session`, `parse_codex_rollout`) already iterate every line of every session file at run time. Extend them to track the min and max record `timestamp` (skipping records without one), and have `capture_tokens` aggregate `first_ts` = min across files, `last_ts` = max across files, `duration_ms` = their delta. These three fields are written into `coding-agent-token-usage.json` alongside the existing token/cost data — so the coding-agent's wall-clock is frozen at run time in the same pass and the same file as its cost. `duration_ms` is null when no record carried a timestamp.

### 1b. Multi-model coding-agent cost (amendment — PRI-1872 review finding)

A single SDD run is **multi-model**: the main coding agent runs Opus while its dispatched subagents run Sonnet and Haiku (verified on `sdd-svelte-todo-claude`: 119 Opus turns, 481 Sonnet, 321 Haiku). The original `token_usage.py` summed all tokens into one pool and priced it at a single model's rate (whichever file it saw first → Opus), inflating cost ~2.4× ($78.49 vs the correct $32.98; the corrected per-model split cross-checks against the live Anthropic dashboard to within lag).

Fix: track usage **per model**, price each model with its own table, sum the per-model costs.

- `parse_claude_session` / `parse_codex_rollout` return a `by_model` map: `{model_id: {total_input, total_cache_create, total_cache_read, total_output, n_assistant_turns}}` (Codex has a single entry). The existing flat aggregate keys are retained.
- `capture_tokens` aggregates `by_model` across all session files (summing per model), computes each model's `est_cost_usd` via `pricing_for_model` + `estimate_cost_with`, and sets the top-level `est_cost_usd` = **sum of per-model costs**. It emits a `models` block: `{model_id: {tokens..., est_cost_usd}}`.
- A model with no pricing entry contributes its tokens but `est_cost_usd = null` for that sub-entry; the run total is still summed from the priced ones and the file flags any unpriced model.

`coding-agent-token-usage.json` therefore carries: the flat totals (unchanged keys), `duration_ms`/`first_ts`/`last_ts` (§1a), a `models` per-model breakdown, and a corrected top-level `est_cost_usd`.

Economics' coding-agent block surfaces the `models` breakdown; `show` renders the Coding-Agent as per-model sub-rows.

### 2. Pricing — extend `token_usage.py`

- Add a `pricing_for_model(model_id: str) -> dict | None` resolver: substring match on the model id (`opus`→Opus table, `sonnet`→new Sonnet 4.x table, `gpt`/`codex`→GPT-5.5 table), returns `None` for unrecognized ids.
- Add the **Claude Sonnet 4.x** pricing table (the Gauntlet-Agent runs Sonnet; today only Opus + GPT-5.5 exist).
- Add a `PRICING_ASOF = "2026-05"` constant; surface it in the economics block.
- The existing coding-agent path (family-based pricing in `capture_tokens`) is unchanged — economics reuses its frozen `est_cost_usd`, so there is no second pricing code path for the coding agent and no regression risk. The model→pricing resolver is used only for the gauntlet-agent.
- Unknown/unpriced model: tokens still reported, `est_cost_usd = null`.

### 3. `composer.py`

- `FinalVerdict` gains an optional `economics` field. `compose(...)` accepts the `RunEconomics` (built by the runner from the run dir) and serializes it into `verdict.json`.
- **Measurement only** — economics never influences `final`. Consistent with how token-usage is already treated.

### 4. `runner.py`

- After capture (where `capture_token_usage` already runs), call `build_run_economics(run_dir)` and pass it into `compose(...)`. This is the run-time computation point that freezes the cost.

### 5. `show.py` — new "Economics" pane

Rendered from `verdict.json["economics"]` only (no recompute):

```
─── Economics ────────────────────────────────────
              duration      tokens        est cost
Gauntlet      31m 25s       7.1M           $0.42
Coding        24m 03s       2.3M           $1.85
total                                      $2.27
```

- Each row degrades to `—` when its source block is missing.
- Unpriced model: cost cell shows `n/a (sonnet-x)`.
- `total` omitted (or shown as `partial`) when either cost is null.

### 6. `run-all` batch matrix

- Add an est-cost column (wall-clock already present), reading each run's frozen `verdict.json["economics"]["total_est_cost_usd"]`.
- Footer gains a batch cost total (sum of per-run totals that are non-null).

## Edge cases

- Missing `result.json` (gauntlet never produced a verdict) → gauntlet block null, `partial=true`.
- Missing `coding-agent-token-usage.json` (capture failed, or a backend `token_usage.py` doesn't parse — gemini/pi) → coding-agent block null, `partial=true`.
- Session logs present but no timestamped records → `duration_ms = null` for that agent (cost may still be present).
- Unpriced model → tokens present, cost null, rendered `n/a (model)`.

## Backfill (PRI-1872 follow-on)

Runs that predate this feature have no `economics` in their `verdict.json`, and runs that predate the per-model fix carry a stale single-model cost in `coding-agent-token-usage.json`. Since the raw session logs and `result.json` are preserved per run dir, `quorum backfill-economics [run-dir | --all]` re-derives economics: it detects the backend from the run's isolated `coding-agent-config/` layout (`projects/` → claude, `sessions/` → codex), re-runs `capture_tokens` over the logs (regenerating the per-model sidecar + duration span), and injects an `economics` block into the existing `verdict.json`.

This **re-prices at current pricing tables** — a deliberate re-pricing, not a faithful replay of run-time cost. Acceptable for correcting the multi-model bug (the old numbers were wrong, not "right at old rates"). Runs that never launched an agent (setup/indeterminate failures) report "no economics sources" and are left without an economics block.

## Non-goals

- Phased (setup / agent-drive / checks) timing breakdown.
- Recomputing the coding-agent cost — reuse the frozen value.
- Any change to pass/fail semantics.
- Live/real-time cost during a run — this is a post-run report.

## Acceptance

- `verdict.json` carries an `economics` block with both agents' duration, tokens, cost, a summed total, `pricing_asof`, and `partial`.
- Economics is computed at run time in the composer path; re-running `quorum show` on an old run renders identical frozen numbers.
- Sonnet pricing added; gauntlet-agent cost computed from `result.json` usage.
- Coding-agent duration captured in `token_usage.py` (session-log timestamp span across all files) and frozen into `coding-agent-token-usage.json`.
- `quorum show` renders the Economics pane; `run-all` shows a cost column + batch total.
- Missing sources degrade to `—`/`partial` without crashing.
- Unit tests: economics builder (both agents present; each missing; unpriced model; no-timestamp logs), pricing resolver, show pane rendering, run-all column.
