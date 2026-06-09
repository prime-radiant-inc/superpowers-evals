# Quorum → Obol Cost-Capture Migration

**Date:** 2026-06-09
**Status:** Approved design, pending implementation plan

## Problem

Quorum computes token cost twice over, with code it should not own. For the
Coding-Agent, `quorum/token_usage.py` hand-parses three session-log dialects
(Claude Code, Codex, Kimi) and prices them against hardcoded constants that go
stale (a stale Opus rate once inflated cost ~3x). For the Gauntlet-Agent,
`quorum/economics.py` trusts a self-reported usage block in `result.json` and
prices it against the same constants.

[Obol](https://github.com/prime-radiant-inc/obol) now owns both jobs. Its Rust
core parses eight transcript dialects — including `claude`, `codex`, `kimi`,
and the `obol` usage-sidecar dialect — and prices them against a LiteLLM/
OpenRouter snapshot. Gauntlet now emits that sidecar (`usage.jsonl`, rows of
`type: "obol.usage"`) for every LLM call it makes. Obol's per-session totals
were validated against this repo's own numbers.

This migration deletes Quorum's parsers and pricing tables and makes Obol the
single cost engine for both actors.

## Decisions

| Question | Decision |
|---|---|
| Sequencing | Full cutover, one PR — both actors, delete `token_usage.py` |
| Non-cost metrics | Keep `duration_ms` via a small timing helper. Drop `tool_result_total_bytes` (no consumers) and `n_assistant_turns` (test-only). |
| Pricing source | Obol's defaults at runtime (embedded snapshot; a machine-level `obol refresh` yields fresher prices). No pinning: runs are one-shot, cost freezes into the run dir at run time, nothing re-evaluates. |
| Tests | Hermetic via a committed, reduced, test-only pricing snapshot (`OBOL_PRICING_DIR`), exercising the real FFI → parse → price pipeline. |
| Artifact schema | Hybrid: keep the existing economics shell (`tokens`, `est_cost_usd`, `duration_ms`, `models`) so `show` renders old and new runs with one code path; nest Obol's verbatim estimate as provenance. |
| Backwards compatibility | None engineered. The only rule: never crash on a missing file or field — degrade to `None` + `partial: true`. Delete `quorum backfill-economics` (it exists solely to retrofit old runs). |

## Architecture

**Dependency:** add `primeradianthq-obol` (PyPI; wheel bundles the native
library). Remove `anthropic` — declared but never imported.

| Module | Fate |
|---|---|
| `quorum/token_usage.py` | Deleted: parsers, pricing constants, `PRICING_ASOF`, cost estimators. |
| `quorum/obol_capture.py` | New (~100 lines). `estimate_session_logs(backend_family, files)` maps backend → Obol dialect, calls `obol.estimate_path()` per file, and merges the estimates: sum token buckets and `subtotal_usd` per model, union `unpriced_models` and `approximations`. Obol prices; this module only adds. |
| `quorum/timing.py` | New (~50 lines). Scans session logs for first/last timestamps → `duration_ms`. The only survivor of the old parsers. |
| `quorum/capture.py` | `capture_token_usage` composes the merged estimate + timing into the frozen `coding-agent-token-usage.json` (same filename). |
| `quorum/economics.py` | Both agent blocks Obol-fed (below). Composition contract unchanged. `backfill_run_economics` deleted. |
| `quorum/show.py` | Rendering unchanged, plus a pricing-provenance footnote. |
| `quorum/cli.py` | `backfill-economics` command deleted. |

**Data flow:**

```
Coding-Agent session logs ──┐
  (claude/codex/kimi JSONL) ├─ obol.estimate_path(dialect=claude|codex|kimi)
                            │      ↓ merge per-file
                            │  capture.py → coding-agent-token-usage.json  (frozen)
                            │
Gauntlet usage.jsonl ───────┴─ obol.estimate_path(dialect="obol")
  (obol.usage sidecar)             ↓
                          economics.py → verdict.json economics block
                                   ↓
                          show.py (renders verbatim)
```

The backend → dialect table covers every dialect Obol knows (`claude`,
`codex`, `kimi`, `gemini`, `copilot`, `pi`, `opencode`). Backends whose logs
Obol cannot parse degrade exactly as today (`usage = None`, `partial: true`);
backends it can parse gain pricing for free.

## Capture paths

**Coding-Agent.** Session-log discovery is unchanged (per-run isolated config
dir). Each file gets its own `estimate_path` call — Claude spawns subagents
into sibling JSONLs — and the merge sums them. `pricing_as_of` agrees across
files (same process, same snapshot); first wins. Any `ObolError` → usage
`None` → `partial: true`. Never a silent $0.

**Gauntlet.** Read `gauntlet-agent/results/<runId>/usage.jsonl` with
`dialect="obol"`. Tokens, cost, and model come from the estimate;
`duration_ms` comes from `result.json` as today. Missing or unparseable
`usage.jsonl` → `est_cost_usd: None`, `partial: true`; duration and model are
still picked up from `result.json` when present. No fallback pricing path.

## Frozen artifact schemas

**`coding-agent-token-usage.json`** — top keys as today minus the dropped
metrics, plus Obol provenance:

```json
{
  "total_input": 1200, "total_cache_create": 60, "total_cache_read": 4800,
  "total_output": 350, "total_tokens": 6410,
  "model": "claude-opus-4-8",
  "models": {
    "claude-opus-4-8": {
      "total_input": 1200, "total_cache_create": 60, "total_cache_read": 4800,
      "total_output": 350, "total_tokens": 6410, "est_cost_usd": 0.0145
    }
  },
  "est_cost_usd": 0.0145,
  "duration_ms": 84000,
  "unpriced_models": [],
  "approximations": [],
  "pricing_as_of": "2026-06-04",
  "pricing_source": "bundled"
}
```

Bucket mapping: Obol `cache_write` → Quorum `cache_create`.

**Implementation deviation (2026-06-09):** `pricing_source` is omitted from
the artifacts — obol's Python binding does not expose it (the Rust core
serializes it, but `CostEstimate.from_json` drops the field). The footnote
renders from `pricing_as_of` alone. If the binding gains the field, thread
it through `obol_capture._merge_estimates`.

**`verdict.json` economics block** — shell unchanged (`gauntlet` /
`coding_agent`, each with `duration_ms`, `model`, `tokens{}`, `est_cost_usd`;
plus `total_est_cost_usd`, `partial`). Changes:

- `pricing_asof` carries the snapshot date from Obol, not a constant.
- `has_unpriced_model` derives from `unpriced_models != []`.
- Each agent block nests an `obol` provenance object: `per_model`,
  `unpriced_models`, `approximations`, `pricing_as_of`, `pricing_source`.

## Error handling

| Failure | Result |
|---|---|
| `ObolError` on any session file | coding usage `None` → `partial: true` |
| `usage.jsonl` missing or unparseable | gauntlet cost `None` → `partial: true` |
| Model absent from snapshot | listed in `unpriced_models`; `has_unpriced_model: true`; never a silent $0 |
| Gauntlet bumps the sidecar schema version | Obol rejects the rows → `partial: true` until Obol updates |
| Missing fields anywhere | `.get()` with defaults; `None` propagates |

## Show

Existing panes render unchanged. When an agent block carries `obol`
provenance, append one footnote line:

```
pricing: litellm @ 2026-06-04 (bundled) · codex tier assumed standard
```

Date and source come from the provenance; the trailing clause appears only
when `approximations` is non-empty. Blocks without provenance get no footnote.

## Testing

- `tests/fixtures/pricing/` — a reduced snapshot (`current.json` trimmed to
  the few models tests use) plus a README marking it **test-only fixture
  data, not maintained as real pricing**. A pytest fixture applies it via an
  `OBOL_PRICING_DIR` monkeypatch, so tests are hermetic against machine XDG
  state and exercise the real FFI → parse → price pipeline. No stubs.
- Mini transcript fixtures: a multi-file Claude session (covers subagent
  merge), a Codex rollout, a Kimi wire, and a Gauntlet `usage.jsonl`.
- `test_token_usage.py` → deleted. New: `test_obol_capture.py` (dialect map,
  merge math, unpriced surfacing, `ObolError` → `None`) and `test_timing.py`.
  `test_economics.py` and `test_show.py` updated for provenance and footnote.
- One smoke test runs without `OBOL_PRICING_DIR` and asserts shape only
  (cost > 0), proving the embedded-snapshot path.

## Pre-merge verification (trusted-maintainer, not CI)

1. **Reconcile:** recompute cost via Obol over preserved session logs of
   recent local run dirs; diff against frozen `est_cost_usd`. Obol was
   validated against this repo's numbers, so expect parity modulo snapshot
   drift. Record the diff in the PR.
2. **Live runs:** one `quorum run` each for claude and codex against current
   Gauntlet (which emits `usage.jsonl`); inspect `quorum show` economics
   end to end.
3. **Safe checks:** `uv run ruff check`, `uv run ty check`,
   `uv run quorum check`, `uv run pytest`.

## Out of scope

- Obol documentation fixes (handled separately, in the `obol` repo).
- Verifying that gemini/copilot/pi session logs match Obol's dialects — the
  table maps them, and they degrade safely if the formats diverge.
- Any re-pricing or archival tooling for historical runs.
