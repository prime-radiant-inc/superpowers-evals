# Quorum → Obol Cost-Capture Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace quorum's hand-rolled token parsers and pricing constants with obol, pricing both the Coding-Agent (session logs) and the Gauntlet-Agent (`usage.jsonl` sidecar).

**Architecture:** A new `quorum/obol_capture.py` owns every obol call and merges per-file `CostEstimate`s into the frozen-artifact dict shape; a new `quorum/timing.py` keeps `duration_ms` alive. `capture.py` and `economics.py` rewire onto those two modules; `token_usage.py` and `backfill-economics` are deleted. The `verdict.json` economics shell is unchanged; obol provenance nests inside it.

**Tech Stack:** Python 3.11 + uv; `primeradianthq-obol` (ctypes binding over obol's Rust core; native lib bundled in the wheel); pytest.

**Spec:** `docs/superpowers/specs/2026-06-09-quorum-obol-migration-design.md`
**Ticket:** PRI-2130

**Key obol facts** (verified against `~/Code/prime/obol` @ v0.3.0):

- `obol.estimate_path(path, dialect) -> CostEstimate`. Dialects: `claude`, `codex`, `kimi`, `gemini`, `copilot`, `pi`, `opencode`, `obol` (the usage-sidecar dialect Gauntlet emits).
- `CostEstimate`: `.total_usd: float`, `.per_model: list[ModelCost]`, `.tokens: TokenBuckets`, `.unpriced_models: list[str]`, `.approximations: list[Approximation(kind, detail)]`, `.pricing_as_of: str`. `ModelCost`: `.model`, `.provider`, `.tokens`, `.subtotal_usd`. `TokenBuckets`: `.input`, `.output`, `.cache_read`, `.cache_write` (obol `cache_write` == quorum `cache_create`).
- The Python binding does **not** expose `pricing_source` (the Rust core serializes it; `CostEstimate.from_json` drops it). Treat it as unavailable; Task 8 notes this deviation in the spec.
- Errors raise `obol.ObolError` (`.code`, `.kind`, `.message`).
- Pricing resolution: `OBOL_PRICING_DIR` (must contain `current.json`) wins absolutely; otherwise newer-of {embedded snapshot, `$XDG_DATA_HOME/obol/current.json`}. Estimate works offline out of the box.
- Codex: obol bills `reasoning_output_tokens` as output (obol PRI-2124) and reports uncached input in the `input` bucket (`input_tokens - cached_input_tokens`).

---

### Task 1: Branch + dependency swap

**Files:**
- Modify: `pyproject.toml` (deps only; via `uv` commands, not hand-edit)

- [ ] **Step 1: Create the work branch**

```bash
cd /Users/mw/Code/prime/superpowers-evals
git checkout -b matt/pri-2130-superpowers-evals-adopt-obol-for-run-cost-capture-coding
```

- [ ] **Step 2: Swap dependencies**

```bash
uv remove anthropic
uv add primeradianthq-obol
```

- [ ] **Step 3: Verify obol imports and works offline**

```bash
uv run python -c "import obol; print(obol.version())"
```

Expected: a version string (e.g. `0.2.0`+). If this fails with a library-load error, the wheel for this platform is missing — stop and flag it.

- [ ] **Step 4: Verify nothing imported anthropic**

```bash
grep -rn "import anthropic\|from anthropic" --include="*.py" quorum/ setup_helpers/ tests/ bin/ || echo CLEAN
```

Expected: `CLEAN`.

- [ ] **Step 5: Run the existing suite (must still pass — nothing rewired yet)**

```bash
uv run pytest -x -q
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add pyproject.toml uv.lock
git commit -m "chore: swap anthropic dep for primeradianthq-obol (PRI-2130)"
```

---

### Task 2: Test pricing fixture + conftest wiring + smoke test

The whole suite must price against a committed snapshot, not whatever
`~/.local/share/obol/current.json` a dev machine happens to have.

**Files:**
- Create: `tests/quorum/fixtures/pricing/current.json`
- Create: `tests/quorum/fixtures/pricing/README.md`
- Modify: `tests/quorum/conftest.py`
- Test: `tests/quorum/test_obol_smoke.py`

- [ ] **Step 1: Write the pricing fixture**

`tests/quorum/fixtures/pricing/current.json` — obol `PriceStore` shape
(`as_of` + `namespaces.litellm.{model: per-1M USD rates}`). Only the models
the test suite uses:

```json
{
  "as_of": "2026-06-09",
  "namespaces": {
    "litellm": {
      "claude-opus-4-7": {"input": 5.0, "output": 25.0, "cache_read": 0.5, "cache_write": 6.25},
      "claude-sonnet-4-6": {"input": 3.0, "output": 15.0, "cache_read": 0.3, "cache_write": 3.75},
      "gpt-5.5": {"input": 5.0, "output": 30.0, "cache_read": 0.5, "cache_write": 0.0},
      "kimi-for-coding": {"input": 1.0, "output": 3.0, "cache_read": 0.1, "cache_write": 1.25}
    }
  }
}
```

- [ ] **Step 2: Write the fixture README**

`tests/quorum/fixtures/pricing/README.md`:

```markdown
# Test-only obol pricing snapshot

Fixture data for the quorum test suite, applied via `OBOL_PRICING_DIR`
(see `tests/quorum/conftest.py`). The rates are frozen so cost
assertions are deterministic — they are NOT maintained as real pricing.
Real runs use obol's own resolution (embedded snapshot or a local
`obol refresh`). Add a model here only when a test needs it priced.
```

- [ ] **Step 3: Add the autouse conftest fixture**

Append to `tests/quorum/conftest.py`:

```python
_PRICING_FIXTURE = Path(__file__).parent / "fixtures" / "pricing"


@pytest.fixture(autouse=True)
def _obol_pricing_fixture(monkeypatch):
    """Pin obol to the committed test-only snapshot.

    OBOL_PRICING_DIR wins absolutely in obol's resolution, so tests are
    hermetic against the embedded snapshot's version and any local
    `obol refresh` state. Tests that want the default resolution
    (test_obol_smoke.py) delenv it explicitly.
    """
    monkeypatch.setenv("OBOL_PRICING_DIR", str(_PRICING_FIXTURE))
```

Add `from pathlib import Path` to the conftest imports.

- [ ] **Step 4: Write the smoke test**

`tests/quorum/test_obol_smoke.py`:

```python
"""Smoke tests for the obol binding itself — pricing resolution both ways."""
import obol
import pytest


def test_fixture_snapshot_prices_exactly(tmp_path):
    """The committed snapshot makes cost math deterministic."""
    f = tmp_path / "s.jsonl"
    f.write_text(
        '{"type":"assistant","message":{"id":"m1","model":"claude-opus-4-7",'
        '"role":"assistant","content":[],"usage":{"input_tokens":100,'
        '"cache_creation_input_tokens":0,"cache_read_input_tokens":0,'
        '"output_tokens":40}}}\n'
    )
    est = obol.estimate_path(f, dialect="claude")
    # 100 * $5/M + 40 * $25/M
    assert est.total_usd == pytest.approx(0.0015)
    assert est.pricing_as_of == "2026-06-09"


def test_embedded_snapshot_works_without_env(tmp_path, monkeypatch):
    """Default resolution (embedded snapshot floor) — shape-only asserts.

    Numbers may differ across machines (a local `obol refresh` overrides
    the embedded floor), so assert structure, never dollars.
    """
    monkeypatch.delenv("OBOL_PRICING_DIR", raising=False)
    f = tmp_path / "s.jsonl"
    f.write_text(
        '{"type":"assistant","message":{"id":"m1","model":"claude-opus-4-8",'
        '"role":"assistant","content":[],"usage":{"input_tokens":1000,'
        '"cache_creation_input_tokens":0,"cache_read_input_tokens":0,'
        '"output_tokens":100}}}\n'
    )
    est = obol.estimate_path(f, dialect="claude")
    assert est.total_usd > 0
    assert est.pricing_as_of
    assert [m.model for m in est.per_model] == ["claude-opus-4-8"]
```

- [ ] **Step 5: Run the smoke tests**

```bash
uv run pytest tests/quorum/test_obol_smoke.py -v
```

Expected: 2 PASS. If `test_fixture_snapshot_prices_exactly` errors with
`PricingTablesMissing`, the conftest fixture isn't applying — fix before
proceeding.

- [ ] **Step 6: Commit**

```bash
git add tests/quorum/fixtures/pricing tests/quorum/conftest.py tests/quorum/test_obol_smoke.py
git commit -m "test: committed obol pricing snapshot + hermetic conftest wiring (PRI-2130)"
```

---

### Task 3: `quorum/timing.py`

The one non-cost metric that survives: wall-clock span of the session logs.

**Files:**
- Create: `quorum/timing.py`
- Test: `tests/quorum/test_timing.py`

- [ ] **Step 1: Write the failing tests**

`tests/quorum/test_timing.py`:

```python
import json

from quorum.timing import session_logs_duration_ms


def _write(path, rows):
    path.write_text("\n".join(json.dumps(r) for r in rows) + "\n")


def test_iso_timestamps_span(tmp_path):
    f = tmp_path / "s.jsonl"
    _write(f, [
        {"type": "user", "timestamp": "2026-06-09T00:00:00.000Z"},
        {"type": "assistant", "timestamp": "2026-06-09T00:01:24.000Z"},
    ])
    assert session_logs_duration_ms([f]) == 84_000


def test_numeric_time_span(tmp_path):
    # Kimi usage.record rows carry epoch-ms `time`.
    f = tmp_path / "wire.jsonl"
    _write(f, [
        {"type": "usage.record", "time": 1_800_000_000_000},
        {"type": "usage.record", "time": 1_800_000_042_000},
    ])
    assert session_logs_duration_ms([f]) == 42_000


def test_span_crosses_files(tmp_path):
    # Claude subagents land in sibling files; the span covers all of them.
    a, b = tmp_path / "a.jsonl", tmp_path / "b.jsonl"
    _write(a, [{"timestamp": "2026-06-09T00:00:00Z"}])
    _write(b, [{"timestamp": "2026-06-09T00:00:30Z"}])
    assert session_logs_duration_ms([a, b]) == 30_000


def test_no_timestamps_returns_none(tmp_path):
    f = tmp_path / "s.jsonl"
    _write(f, [{"type": "user"}, {"type": "assistant"}])
    assert session_logs_duration_ms([f]) is None


def test_garbage_lines_skipped(tmp_path):
    f = tmp_path / "s.jsonl"
    f.write_text(
        'not json\n'
        '{"timestamp": "2026-06-09T00:00:00Z"}\n'
        '{"timestamp": 42}\n'
        '{"timestamp": "2026-06-09T00:00:10Z"}\n'
    )
    assert session_logs_duration_ms([f]) == 10_000


def test_missing_file_ignored(tmp_path):
    assert session_logs_duration_ms([tmp_path / "nope.jsonl"]) is None
```

- [ ] **Step 2: Run to verify failure**

```bash
uv run pytest tests/quorum/test_timing.py -v
```

Expected: FAIL with `ModuleNotFoundError: No module named 'quorum.timing'`.

- [ ] **Step 3: Implement**

`quorum/timing.py`:

```python
"""Wall-clock span of session logs — the one non-cost metric obol doesn't own.

Cost capture moved to obol (PRI-2130); duration_ms stayed behind because it
comes from log timestamps, not token usage. Scans every JSONL row for either
an ISO-8601 `timestamp` (Claude Code, Codex) or an epoch-ms numeric `time`
(Kimi) and returns last - first in milliseconds.
"""
from __future__ import annotations

import json
from datetime import datetime
from pathlib import Path


def _iso_to_ms(ts: str) -> float | None:
    try:
        return datetime.fromisoformat(ts.replace("Z", "+00:00")).timestamp() * 1000
    except ValueError:
        return None


def session_logs_duration_ms(files: list[Path]) -> int | None:
    """Span in ms across all timestamps found in *files*, or None if none."""
    points: list[float] = []
    for path in files:
        try:
            text = path.read_text()
        except OSError:
            continue
        for line in text.splitlines():
            if not line.strip():
                continue
            try:
                rec = json.loads(line)
            except json.JSONDecodeError:
                continue
            if not isinstance(rec, dict):
                continue
            ts = rec.get("timestamp")
            if isinstance(ts, str):
                ms = _iso_to_ms(ts)
                if ms is not None:
                    points.append(ms)
            t = rec.get("time")
            if isinstance(t, (int, float)) and not isinstance(t, bool):
                points.append(float(t))
    if not points:
        return None
    return max(int(max(points) - min(points)), 0)
```

- [ ] **Step 4: Run to verify pass**

```bash
uv run pytest tests/quorum/test_timing.py -v
```

Expected: 6 PASS.

- [ ] **Step 5: Commit**

```bash
git add quorum/timing.py tests/quorum/test_timing.py
git commit -m "feat: session-log timing helper (duration_ms survives the obol cutover) (PRI-2130)"
```

---

### Task 4: `quorum/obol_capture.py` — the only module that talks to obol

**Files:**
- Create: `quorum/obol_capture.py`
- Test: `tests/quorum/test_obol_capture.py`

- [ ] **Step 1: Write the failing tests**

`tests/quorum/test_obol_capture.py`:

```python
import json

import pytest

from quorum.obol_capture import estimate_session_logs, estimate_usage_sidecar

# Fixture rates (tests/quorum/fixtures/pricing/current.json, per-1M USD):
# opus-4-7   in 5.0 / out 25.0 / cr 0.5 / cw 6.25
# sonnet-4-6 in 3.0 / out 15.0 / cr 0.3 / cw 3.75
# gpt-5.5    in 5.0 / out 30.0 / cr 0.5 / cw 0.0
# kimi       in 1.0 / out  3.0 / cr 0.1 / cw 1.25


def _claude_row(model, mid, inp, cc, cr, out):
    return json.dumps({
        "type": "assistant",
        "timestamp": "2026-06-09T00:00:00Z",
        "message": {
            "id": mid, "model": model, "role": "assistant", "content": [],
            "usage": {
                "input_tokens": inp, "cache_creation_input_tokens": cc,
                "cache_read_input_tokens": cr, "output_tokens": out,
            },
        },
    }) + "\n"


class TestEstimateSessionLogs:
    def test_claude_multi_file_merge(self, tmp_path):
        # Main session (opus) + subagent sibling file (sonnet): buckets and
        # cost merge across files, per-model breakdown keeps both.
        main = tmp_path / "main.jsonl"
        main.write_text(_claude_row("claude-opus-4-7", "m1", 100, 1000, 50, 20)
                        + _claude_row("claude-opus-4-7", "m2", 50, 0, 1100, 30))
        sub = tmp_path / "sub.jsonl"
        sub.write_text(_claude_row("claude-sonnet-4-6", "s1", 10, 0, 0, 5))

        usage = estimate_session_logs("claude", [main, sub])

        assert usage["total_input"] == 160
        assert usage["total_cache_create"] == 1000
        assert usage["total_cache_read"] == 1150
        assert usage["total_output"] == 55
        assert usage["total_tokens"] == 160 + 1000 + 1150 + 55
        # opus: (150*5 + 1000*6.25 + 1150*0.5 + 50*25)/1e6 = 0.008825
        # sonnet: (10*3 + 5*15)/1e6 = 0.000105
        assert usage["est_cost_usd"] == pytest.approx(0.00893)
        assert usage["model"] == "claude-opus-4-7"  # costliest model
        assert usage["models"]["claude-sonnet-4-6"]["est_cost_usd"] == pytest.approx(0.000105)
        assert usage["unpriced_models"] == []
        assert usage["pricing_as_of"] == "2026-06-09"

    def test_codex_rollout(self, tmp_path):
        f = tmp_path / "rollout.jsonl"
        f.write_text(
            (FIXTURES / "codex_rollout.jsonl").read_text()
        )
        usage = estimate_session_logs("codex", [f])
        # Last cumulative token_count wins: input 2000 (900 cached) -> 1100
        # uncached; output 120 + 40 reasoning = 160 (obol bills reasoning
        # as output, obol PRI-2124).
        assert usage["total_input"] == 1100
        assert usage["total_cache_read"] == 900
        assert usage["total_cache_create"] == 0
        assert usage["total_output"] == 160
        assert usage["est_cost_usd"] == pytest.approx(
            (1100 * 5.0 + 900 * 0.5 + 160 * 30.0) / 1e6
        )

    def test_kimi_wire(self, tmp_path):
        f = tmp_path / "wire.jsonl"
        f.write_text(json.dumps({
            "type": "usage.record", "usageScope": "turn",
            "model": "kimi-for-coding", "time": 1_800_000_000_000,
            "usage": {"inputOther": 10, "inputCacheRead": 20,
                      "inputCacheCreation": 30, "output": 40},
        }) + "\n")
        usage = estimate_session_logs("kimi", [f])
        assert usage["total_tokens"] == 100
        # (10*1 + 20*0.1 + 30*1.25 + 40*3)/1e6
        assert usage["est_cost_usd"] == pytest.approx(0.0001695)

    def test_unknown_backend_returns_none(self, tmp_path):
        f = tmp_path / "s.jsonl"
        f.write_text("{}\n")
        assert estimate_session_logs("antigravity", [f]) is None

    def test_unparseable_file_returns_none(self, tmp_path):
        # A backend obol knows, but a file its parser rejects -> None,
        # never a partial sum. (gemini dialect, garbage content.)
        f = tmp_path / "transcript.jsonl"
        f.write_text("definitely not a gemini transcript\n")
        assert estimate_session_logs("gemini", [f]) is None

    def test_zero_usage_returns_none(self, tmp_path):
        # Parsable file, no usage rows -> None (no junk zero-cost files).
        f = tmp_path / "s.jsonl"
        f.write_text('{"type":"user","message":{"role":"user","content":"hi"}}\n')
        assert estimate_session_logs("claude", [f]) is None

    def test_no_files_returns_none(self):
        assert estimate_session_logs("claude", []) is None

    def test_unpriced_model_surfaces(self, tmp_path):
        f = tmp_path / "s.jsonl"
        f.write_text(_claude_row("mystery-model-9", "m1", 100, 0, 0, 10))
        usage = estimate_session_logs("claude", [f])
        assert usage["unpriced_models"] == ["mystery-model-9"]
        assert usage["est_cost_usd"] is None  # all-unpriced: no silent $0
        assert usage["total_input"] == 100   # tokens still reported


class TestEstimateUsageSidecar:
    def test_gauntlet_sidecar(self, tmp_path):
        f = tmp_path / "usage.jsonl"
        f.write_text(json.dumps({
            "type": "obol.usage", "v": "2026-06-08", "provider": "anthropic",
            "model": "claude-sonnet-4-6", "service_tier": "standard",
            "usage": {"input_tokens": 12, "cache_read_input_tokens": 120,
                      "cache_creation_input_tokens": 60, "output_tokens": 9},
        }) + "\n")
        usage = estimate_usage_sidecar(f)
        assert usage["total_input"] == 12
        assert usage["total_cache_create"] == 60
        assert usage["total_cache_read"] == 120
        assert usage["total_output"] == 9
        # (12*3 + 60*3.75 + 120*0.3 + 9*15)/1e6
        assert usage["est_cost_usd"] == pytest.approx(0.000432)
        assert usage["model"] == "claude-sonnet-4-6"

    def test_missing_file_returns_none(self, tmp_path):
        assert estimate_usage_sidecar(tmp_path / "usage.jsonl") is None

    def test_unparseable_sidecar_returns_none(self, tmp_path):
        f = tmp_path / "usage.jsonl"
        f.write_text('{"type":"obol.usage","v":"2099-01-01","provider":"x","usage":{}}\n')
        assert estimate_usage_sidecar(f) is None
```

Add at module top, after the imports:

```python
from pathlib import Path

FIXTURES = Path(__file__).parent / "fixtures"
```

- [ ] **Step 2: Run to verify failure**

```bash
uv run pytest tests/quorum/test_obol_capture.py -v
```

Expected: FAIL with `ModuleNotFoundError: No module named 'quorum.obol_capture'`.

- [ ] **Step 3: Implement**

`quorum/obol_capture.py`:

```python
"""All quorum↔obol traffic: estimate session logs / usage sidecars, merge, re-shape.

obol owns parsing and pricing (PRI-2130); this module owns the quorum-side
dict shape that freezes into run artifacts. estimate_path is single-file, so
multi-file runs (Claude subagents write sibling JSONLs) merge here — plain
addition over obol's outputs, never token math of our own.

Capture is best-effort measurement: every failure path returns None and the
caller degrades to `partial: true`. Never raise, never write a silent $0.
"""
from __future__ import annotations

from pathlib import Path
from typing import Any

import obol

# quorum normalizer name -> obol dialect. Covers every dialect obol knows;
# backends absent here (antigravity) simply aren't priced. A mapped backend
# whose log format diverges from obol's parser degrades to None at parse
# time, so listing one costs nothing.
DIALECTS: dict[str, str] = {
    "claude": "claude",
    "codex": "codex",
    "copilot": "copilot",
    "gemini": "gemini",
    "kimi": "kimi",
    "opencode": "opencode",
    "pi": "pi",
}

_BUCKET_KEYS = ("total_input", "total_cache_create", "total_cache_read", "total_output")


def _empty_bucket() -> dict[str, int]:
    return dict.fromkeys(_BUCKET_KEYS, 0)


def _merge_estimates(estimates: list[obol.CostEstimate]) -> dict[str, Any] | None:
    """Sum obol CostEstimates into the frozen-artifact dict shape.

    Cost is additive across files, so summing subtotals is exact — no
    re-pricing happens here. Returns None when the merged result carries no
    usage at all (parsable files with zero usage rows produce no artifact).
    """
    per_model: dict[str, dict[str, Any]] = {}
    unpriced: set[str] = set()
    approximations: list[dict[str, Any]] = []
    seen_approx: set[tuple[str, str | None]] = set()
    pricing_as_of = None

    for est in estimates:
        pricing_as_of = pricing_as_of or est.pricing_as_of
        unpriced.update(est.unpriced_models)
        for a in est.approximations:
            key = (a.kind, a.detail)
            if key not in seen_approx:
                seen_approx.add(key)
                approximations.append({"kind": a.kind, "detail": a.detail})
        for mc in est.per_model:
            bucket = per_model.setdefault(
                mc.model,
                {**_empty_bucket(), "provider": mc.provider, "subtotal_usd": 0.0},
            )
            bucket["total_input"] += mc.tokens.input
            bucket["total_cache_create"] += mc.tokens.cache_write
            bucket["total_cache_read"] += mc.tokens.cache_read
            bucket["total_output"] += mc.tokens.output
            bucket["subtotal_usd"] += mc.subtotal_usd

    totals = _empty_bucket()
    for bucket in per_model.values():
        for k in _BUCKET_KEYS:
            totals[k] += bucket[k]
    total_tokens = sum(totals.values())
    if total_tokens == 0 and not per_model:
        return None

    total_usd = sum(b["subtotal_usd"] for b in per_model.values())
    all_unpriced = bool(unpriced) and not any(
        b["subtotal_usd"] > 0 for b in per_model.values()
    )

    models_out = {
        m: {
            **{k: b[k] for k in _BUCKET_KEYS},
            "total_tokens": sum(b[k] for k in _BUCKET_KEYS),
            "provider": b["provider"],
            "est_cost_usd": None if m in unpriced else round(b["subtotal_usd"], 6),
        }
        for m, b in per_model.items()
    }
    top_model = max(
        per_model, key=lambda m: per_model[m]["subtotal_usd"], default=None
    ) if per_model else None

    return {
        **totals,
        "total_tokens": total_tokens,
        "model": top_model,
        "models": models_out,
        "est_cost_usd": None if all_unpriced else round(total_usd, 6),
        "unpriced_models": sorted(unpriced),
        "approximations": approximations,
        "pricing_as_of": pricing_as_of,
    }


def estimate_session_logs(
    backend_family: str, session_log_files: list[Path]
) -> dict[str, Any] | None:
    """Price a run's session logs via obol; None when capture isn't possible."""
    dialect = DIALECTS.get(backend_family)
    if dialect is None or not session_log_files:
        return None
    estimates: list[obol.CostEstimate] = []
    for path in session_log_files:
        try:
            estimates.append(obol.estimate_path(path, dialect=dialect))
        except obol.ObolError:
            return None
    return _merge_estimates(estimates)


def estimate_usage_sidecar(path: Path) -> dict[str, Any] | None:
    """Price a gauntlet `usage.jsonl` sidecar (the `obol` dialect)."""
    if not path.is_file():
        return None
    try:
        est = obol.estimate_path(path, dialect="obol")
    except obol.ObolError:
        return None
    return _merge_estimates([est])
```

- [ ] **Step 4: Run to verify pass**

```bash
uv run pytest tests/quorum/test_obol_capture.py -v
```

Expected: 12 PASS. If `test_codex_rollout` fails on `total_output == 160`
vs `120`, the installed obol predates its reasoning-tokens fix (obol
PRI-2124) — bump the dependency, don't bend the test.

- [ ] **Step 5: Commit**

```bash
git add quorum/obol_capture.py tests/quorum/test_obol_capture.py
git commit -m "feat: obol_capture — all cost estimation now flows through obol (PRI-2130)"
```

---

### Task 5: Rewire `capture.py`

**Files:**
- Modify: `quorum/capture.py:20` (import) and `:246-271` (`capture_token_usage`)
- Test: `tests/quorum/test_capture.py:392-479` (class `TestCaptureTokenUsage`)

- [ ] **Step 1: Update the tests first**

In `tests/quorum/test_capture.py`, replace the whole `TestCaptureTokenUsage`
class (lines 392-479) with:

```python
class TestCaptureTokenUsage:
    def test_writes_token_usage_json(self, tmp_path):
        log_dir = _mkdir(tmp_path / "logs")
        snap = snapshot_dir(log_dir, "*.jsonl")
        (log_dir / "session.jsonl").write_text(_claude_session_line(100, 40))
        run_dir = _mkdir(tmp_path / "run")
        out = capture_token_usage(
            log_dir=log_dir, log_glob="*.jsonl", snapshot=snap,
            normalizer="claude", run_dir=run_dir,
        )
        assert out is not None
        assert out == run_dir / "coding-agent-token-usage.json"
        usage = json.loads(out.read_text())
        assert usage["total_input"] == 100
        assert usage["total_output"] == 40
        assert usage["est_cost_usd"] > 0
        assert usage["pricing_as_of"] == "2026-06-09"  # fixture snapshot
        assert "duration_ms" in usage

    def test_no_new_logs_writes_nothing(self, tmp_path):
        # Measurement is best-effort: no logs -> no file, not an empty one.
        log_dir = _mkdir(tmp_path / "logs")
        snap = snapshot_dir(log_dir, "*.jsonl")
        run_dir = _mkdir(tmp_path / "run")
        out = capture_token_usage(
            log_dir=log_dir, log_glob="*.jsonl", snapshot=snap,
            normalizer="claude", run_dir=run_dir,
        )
        assert out is None
        assert not (run_dir / "coding-agent-token-usage.json").exists()

    def test_unparseable_log_writes_nothing(self, tmp_path):
        # gemini is a mapped obol dialect, but obol can't parse `{}` as a
        # gemini transcript -> capture no-ops cleanly.
        log_dir = _mkdir(tmp_path / "logs")
        snap = snapshot_dir(log_dir, "*.jsonl")
        (log_dir / "s.jsonl").write_text("{}\n")
        run_dir = _mkdir(tmp_path / "run")
        out = capture_token_usage(
            log_dir=log_dir, log_glob="*.jsonl", snapshot=snap,
            normalizer="gemini", run_dir=run_dir,
        )
        assert out is None
        assert not (run_dir / "coding-agent-token-usage.json").exists()

    def test_kimi_token_usage_priced_by_obol(self, tmp_path):
        # Pre-obol quorum couldn't price kimi (est None); obol + the fixture
        # snapshot can.
        log_dir = _mkdir(tmp_path / "sessions")
        session_dir = log_dir / "wd" / "session"
        wire_dir = session_dir / "agents" / "main"
        wire_dir.mkdir(parents=True)
        snap = snapshot_dir(log_dir, "**/wire.jsonl")
        launch_cwd = tmp_path / "launch"
        launch_cwd.mkdir()
        wire = wire_dir / "wire.jsonl"
        wire.write_text(
            json.dumps(
                {
                    "type": "usage.record",
                    "usageScope": "turn",
                    "model": "kimi-for-coding",
                    "time": 1800000000000,
                    "usage": {
                        "inputOther": 10,
                        "inputCacheRead": 20,
                        "inputCacheCreation": 30,
                        "output": 40,
                    },
                }
            )
            + "\n"
        )
        (tmp_path / "session_index.jsonl").write_text(
            json.dumps({"sessionDir": str(session_dir), "workDir": str(launch_cwd)}) + "\n"
        )
        run_dir = _mkdir(tmp_path / "run")

        out = capture_token_usage(
            log_dir=log_dir,
            log_glob="**/wire.jsonl",
            snapshot=snap,
            normalizer="kimi",
            run_dir=run_dir,
            launch_cwd=launch_cwd,
        )

        assert out is not None
        data = json.loads(out.read_text())
        assert data["total_tokens"] == 100
        assert data["est_cost_usd"] == pytest.approx(0.0001695)
```

Check the file's imports include `pytest` (add `import pytest` if absent).
If `_claude_session_line` (around line 370) does not set a `message.id` or
`model`, leave it — obol handles id-less assistant rows; but confirm its
`model` value (`claude-opus-4-7` family) exists in the pricing fixture.

- [ ] **Step 2: Run to verify the new tests fail**

```bash
uv run pytest tests/quorum/test_capture.py::TestCaptureTokenUsage -v
```

Expected: FAIL — old `capture_tokens` output lacks `pricing_as_of` /
`duration_ms`, and kimi now expects a price.

- [ ] **Step 3: Rewire `capture_token_usage`**

In `quorum/capture.py`, replace the import at line 20:

```python
from quorum.obol_capture import estimate_session_logs
from quorum.timing import session_logs_duration_ms
```

Replace the body of `capture_token_usage` (lines 246-271):

```python
def capture_token_usage(
    *,
    log_dir: Path,
    log_glob: str,
    snapshot: set[str],
    normalizer: str,
    run_dir: Path,
    launch_cwd: Path | None = None,
) -> Path | None:
    """Price the run's new session logs via obol; write coding-agent-token-usage.json.

    Measurement only — the pass/fail verdict is unaffected.
    coding-agent-token-usage.json sits in run_dir alongside verdict.json; a
    cost scenario reads it from an ordinary deterministic assertion (see
    docs/migration-notes.md, the cost / measurement decision). Returns the
    written path, or None when usage can't be captured — a backend obol has
    no dialect for, a log obol can't parse, or no new session logs — in
    which case no file is written (PRI-2130).
    """
    new = _new_session_logs(log_dir, log_glob, snapshot, normalizer, launch_cwd)
    usage = estimate_session_logs(normalizer, new)
    if usage is None:
        return None
    usage["duration_ms"] = session_logs_duration_ms(new)
    out_path = run_dir / "coding-agent-token-usage.json"
    out_path.write_text(json.dumps(usage, indent=2) + "\n")
    return out_path
```

- [ ] **Step 4: Run to verify pass**

```bash
uv run pytest tests/quorum/test_capture.py -v
```

Expected: PASS (whole file, not just the class).

- [ ] **Step 5: Commit**

```bash
git add quorum/capture.py tests/quorum/test_capture.py
git commit -m "feat: capture_token_usage prices via obol + timing helper (PRI-2130)"
```

---

### Task 6: Rewrite `economics.py`, delete backfill

**Files:**
- Modify: `quorum/economics.py` (full rewrite below)
- Modify: `quorum/cli.py:11` (import) and `:260-300` (`backfill-economics` command — delete)
- Test: `tests/quorum/test_economics.py` (rewrite), `tests/quorum/test_cli.py:471-537` (delete backfill tests)

- [ ] **Step 1: Rewrite the economics tests**

Replace `tests/quorum/test_economics.py` wholesale:

```python
import json

import pytest

from quorum.economics import build_run_economics


def _gauntlet_results(run_dir, *, usage_rows=None, result=None):
    d = run_dir / "gauntlet-agent" / "results" / "run-001"
    d.mkdir(parents=True)
    if result is not None:
        (d / "result.json").write_text(json.dumps(result))
    if usage_rows is not None:
        (d / "usage.jsonl").write_text(
            "".join(json.dumps(r) + "\n" for r in usage_rows)
        )
    return d


_SONNET_ROW = {
    "type": "obol.usage", "v": "2026-06-08", "provider": "anthropic",
    "model": "claude-sonnet-4-6", "service_tier": "standard",
    "usage": {"input_tokens": 12, "cache_read_input_tokens": 120,
              "cache_creation_input_tokens": 60, "output_tokens": 9},
}
# (12*3 + 60*3.75 + 120*0.3 + 9*15)/1e6 against the fixture snapshot
_SONNET_COST = 0.000432

_RESULT = {"duration_ms": 1000, "config": {"model": "claude-sonnet-4-6"}}

_CODING_USAGE = {
    "total_input": 160, "total_cache_create": 1000, "total_cache_read": 1150,
    "total_output": 55, "total_tokens": 2365,
    "model": "claude-opus-4-7",
    "models": {
        "claude-opus-4-7": {
            "total_input": 150, "total_cache_create": 1000,
            "total_cache_read": 1150, "total_output": 50,
            "total_tokens": 2350, "provider": "anthropic",
            "est_cost_usd": 0.008825,
        },
    },
    "est_cost_usd": 0.008825,
    "unpriced_models": [],
    "approximations": [],
    "pricing_as_of": "2026-06-09",
    "duration_ms": 84000,
}


def test_full_economics(tmp_path):
    _gauntlet_results(tmp_path, usage_rows=[_SONNET_ROW], result=_RESULT)
    (tmp_path / "coding-agent-token-usage.json").write_text(json.dumps(_CODING_USAGE))

    econ = build_run_economics(tmp_path)

    g = econ["gauntlet"]
    assert g["duration_ms"] == 1000
    assert g["model"] == "claude-sonnet-4-6"
    assert g["tokens"] == {
        "input": 12, "output": 9, "cache_create": 60, "cache_read": 120,
        "total": 201,
    }
    assert g["est_cost_usd"] == pytest.approx(_SONNET_COST)
    assert g["obol"]["pricing_as_of"] == "2026-06-09"

    c = econ["coding_agent"]
    assert c["duration_ms"] == 84000
    assert c["est_cost_usd"] == pytest.approx(0.008825)
    assert c["models"][0]["model"] == "claude-opus-4-7"
    assert c["has_unpriced_model"] is False
    assert c["obol"]["pricing_as_of"] == "2026-06-09"

    assert econ["total_est_cost_usd"] == pytest.approx(_SONNET_COST + 0.008825)
    assert econ["partial"] is False
    assert econ["pricing_asof"] == "2026-06-09"


def test_missing_usage_sidecar_is_partial(tmp_path):
    # Older gauntlet (no usage.jsonl): cost None, duration/model still shown.
    _gauntlet_results(tmp_path, result=_RESULT)
    (tmp_path / "coding-agent-token-usage.json").write_text(json.dumps(_CODING_USAGE))

    econ = build_run_economics(tmp_path)

    assert econ["gauntlet"]["est_cost_usd"] is None
    assert econ["gauntlet"]["duration_ms"] == 1000
    assert econ["gauntlet"]["model"] == "claude-sonnet-4-6"
    assert econ["partial"] is True
    assert econ["total_est_cost_usd"] is None


def test_missing_coding_usage_is_partial(tmp_path):
    _gauntlet_results(tmp_path, usage_rows=[_SONNET_ROW], result=_RESULT)
    econ = build_run_economics(tmp_path)
    assert econ["coding_agent"] is None
    assert econ["partial"] is True


def test_no_sources_returns_none(tmp_path):
    assert build_run_economics(tmp_path) is None


def test_unpriced_coding_model_is_partial(tmp_path):
    _gauntlet_results(tmp_path, usage_rows=[_SONNET_ROW], result=_RESULT)
    usage = dict(_CODING_USAGE)
    usage["unpriced_models"] = ["mystery-model-9"]
    (tmp_path / "coding-agent-token-usage.json").write_text(json.dumps(usage))

    econ = build_run_economics(tmp_path)

    assert econ["coding_agent"]["has_unpriced_model"] is True
    assert econ["partial"] is True
    assert econ["total_est_cost_usd"] is None


def test_legacy_frozen_file_renders_without_crash(tmp_path):
    # A pre-obol frozen file (no pricing_as_of/unpriced_models/approximations
    # keys): block still builds, with no obol provenance.
    legacy = {
        "total_input": 100, "total_cache_create": 0, "total_cache_read": 0,
        "total_output": 40, "total_tokens": 140, "model": "claude-opus-4-7",
        "est_cost_usd": 0.0015, "duration_ms": 5000, "models": {},
    }
    (tmp_path / "coding-agent-token-usage.json").write_text(json.dumps(legacy))

    econ = build_run_economics(tmp_path)

    c = econ["coding_agent"]
    assert c["est_cost_usd"] == 0.0015
    assert c["obol"] is None
    assert econ["partial"] is True  # no gauntlet block
```

- [ ] **Step 2: Run to verify failure**

```bash
uv run pytest tests/quorum/test_economics.py -v
```

Expected: FAIL (old economics reads result.json usage and prices itself).

- [ ] **Step 3: Rewrite `quorum/economics.py`**

Replace the whole file:

```python
"""Per-run economics: timing + cost for both agents, computed at run time.

Reads the gauntlet-agent's usage.jsonl sidecar (priced via obol) and the
coding-agent's frozen coding-agent-token-usage.json (already obol-priced at
capture time), composes them into a JSON-shaped dict that the runner
persists into verdict.json. Renderers display it verbatim; they never
recompute. No pricing logic lives in quorum (PRI-2130; shell schema from
PRI-1872).

Every read here is best-effort: missing files/fields degrade to None +
`partial: true`, never an exception, never a silent $0.
"""
from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from quorum.obol_capture import estimate_usage_sidecar


def _gauntlet_results_dir(run_dir: Path) -> Path | None:
    base = run_dir / "gauntlet-agent" / "results"
    if not base.is_dir():
        return None
    # Phase 1 is one gauntlet invocation per run-dir: first result dir wins.
    for d in sorted(base.iterdir()):
        if d.is_dir():
            return d
    return None


def _read_json(path: Path) -> dict | None:
    try:
        data = json.loads(path.read_text())
    except (json.JSONDecodeError, OSError):
        return None
    return data if isinstance(data, dict) else None


def _obol_provenance(usage: dict) -> dict | None:
    """The nested provenance block, or None for pre-obol frozen files."""
    if "pricing_as_of" not in usage:
        return None
    return {
        "per_model": usage.get("models") or {},
        "unpriced_models": usage.get("unpriced_models") or [],
        "approximations": usage.get("approximations") or [],
        "pricing_as_of": usage.get("pricing_as_of"),
    }


def _tokens_shell(usage: dict) -> dict:
    return {
        "input": usage.get("total_input", 0),
        "output": usage.get("total_output", 0),
        "cache_create": usage.get("total_cache_create", 0),
        "cache_read": usage.get("total_cache_read", 0),
        "total": usage.get("total_tokens", 0),
    }


def _gauntlet_block(result: dict | None, usage: dict | None) -> dict | None:
    if result is None and usage is None:
        return None
    result = result or {}
    dur = result.get("duration_ms")
    model = (usage or {}).get("model") or (result.get("config") or {}).get("model")
    block: dict[str, Any] = {
        "duration_ms": int(dur) if isinstance(dur, (int, float)) else None,
        "model": model,
        "tokens": _tokens_shell(usage or {}),
        "est_cost_usd": (usage or {}).get("est_cost_usd"),
        "obol": _obol_provenance(usage) if usage else None,
    }
    return block


def _coding_block(usage: dict) -> dict:
    # Per-model breakdown (PRI-1872): a coding run is multi-model (main agent
    # + subagents on different models). `models` carries each model's tokens
    # and cost; `est_cost_usd` is their obol-priced sum (frozen at capture).
    models = []
    for model_id, mt in (usage.get("models") or {}).items():
        models.append({
            "model": model_id,
            "tokens": {
                "input": mt.get("total_input", 0),
                "output": mt.get("total_output", 0),
                "cache_create": mt.get("total_cache_create", 0),
                "cache_read": mt.get("total_cache_read", 0),
                "total": mt.get("total_tokens", 0),
            },
            "est_cost_usd": mt.get("est_cost_usd"),
        })
    models.sort(key=lambda m: m["est_cost_usd"] or 0, reverse=True)
    has_unpriced = bool(usage.get("unpriced_models")) or any(
        m["est_cost_usd"] is None for m in models
    )
    return {
        "duration_ms": usage.get("duration_ms"),
        "model": usage.get("model"),
        "models": models,
        "tokens": _tokens_shell(usage),
        "est_cost_usd": usage.get("est_cost_usd"),
        "has_unpriced_model": has_unpriced,
        "obol": _obol_provenance(usage),
    }


def build_run_economics(run_dir: Path) -> dict | None:
    """Build the economics block for verdict.json, or None if no source exists."""
    results_dir = _gauntlet_results_dir(run_dir)
    g_result = _read_json(results_dir / "result.json") if results_dir else None
    g_usage = (
        estimate_usage_sidecar(results_dir / "usage.jsonl") if results_dir else None
    )
    coding_usage = _read_json(run_dir / "coding-agent-token-usage.json")

    if g_result is None and g_usage is None and coding_usage is None:
        return None

    gauntlet = _gauntlet_block(g_result, g_usage)
    coding = _coding_block(coding_usage) if coding_usage is not None else None

    g_cost = gauntlet["est_cost_usd"] if gauntlet else None
    c_cost = coding["est_cost_usd"] if coding else None
    coding_has_unpriced = bool(coding and coding.get("has_unpriced_model"))
    total = (
        round(g_cost + c_cost, 6)
        if (g_cost is not None and c_cost is not None and not coding_has_unpriced)
        else None
    )
    partial = (gauntlet is None or coding is None
               or g_cost is None or c_cost is None or coding_has_unpriced)

    pricing_asof = None
    for block in (coding, gauntlet):
        prov = (block or {}).get("obol") or {}
        if prov.get("pricing_as_of"):
            pricing_asof = prov["pricing_as_of"]
            break

    return {
        "pricing_asof": pricing_asof,
        "gauntlet": gauntlet,
        "coding_agent": coding,
        "total_est_cost_usd": total,
        "partial": partial,
    }
```

- [ ] **Step 4: Delete the backfill command**

In `quorum/cli.py`: delete the whole `backfill-economics` command (the
`@main.command("backfill-economics")` decorator through the end of its
function body, lines ~260-300) and change the import at line 11 from
`from quorum.economics import backfill_run_economics` — delete that line
entirely (build_run_economics is used by the runner, not the CLI).

In `tests/quorum/test_cli.py`: delete `_backfillable_run` (line ~471) and
both `test_backfill_economics_*` tests (lines ~520-537).

- [ ] **Step 5: Run to verify pass**

```bash
uv run pytest tests/quorum/test_economics.py tests/quorum/test_cli.py -v
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add quorum/economics.py quorum/cli.py tests/quorum/test_economics.py tests/quorum/test_cli.py
git commit -m "feat: economics composes obol-priced blocks; drop backfill-economics (PRI-2130)"
```

---

### Task 7: Show pricing footnote

**Files:**
- Modify: `quorum/show.py:216-236` (`_format_economics_pane`)
- Test: `tests/quorum/test_show.py`

- [ ] **Step 1: Write the failing tests**

Add to `tests/quorum/test_show.py`, next to the existing economics-pane
tests (`test_render_includes_economics_pane`, ~line 421). Those tests build
inline verdict dicts and call `render` — same pattern here:

```python
def test_economics_pricing_footnote(tmp_path):
    from quorum.show import render
    verdict = {
        "final": "pass", "final_reason": "ok",
        "gauntlet": {"status": "pass", "summary": "", "reasoning": ""},
        "checks": [],
        "economics": {
            "pricing_asof": "2026-06-09",
            "gauntlet": {"duration_ms": 1000, "model": "claude-sonnet-4-6",
                         "tokens": {"total": 201}, "est_cost_usd": 0.000432,
                         "obol": {"pricing_as_of": "2026-06-09",
                                  "approximations": [],
                                  "unpriced_models": [], "per_model": {}}},
            "coding_agent": {"duration_ms": 2000, "model": "gpt-5.5",
                             "tokens": {"total": 2160}, "est_cost_usd": 0.01075,
                             "models": [], "has_unpriced_model": False,
                             "obol": {"pricing_as_of": "2026-06-09",
                                      "approximations": [
                                          {"kind": "assumed_standard_tier",
                                           "detail": None}],
                                      "unpriced_models": [], "per_model": {}}},
            "total_est_cost_usd": 0.011182,
            "partial": False,
        },
    }
    out = render(verdict, tmp_path, color=False, mode="full")
    assert "pricing: as of 2026-06-09" in out
    assert "assumed_standard_tier" in out


def test_economics_no_provenance_no_footnote(tmp_path):
    # Pre-obol verdicts (no nested obol blocks) render without a footnote.
    from quorum.show import render
    verdict = {
        "final": "pass", "final_reason": "ok",
        "gauntlet": {"status": "pass", "summary": "", "reasoning": ""},
        "checks": [],
        "economics": {
            "gauntlet": {"duration_ms": 1000, "model": "m",
                         "tokens": {"total": 1}, "est_cost_usd": 0.01},
            "coding_agent": None,
            "total_est_cost_usd": None,
            "partial": True,
        },
    }
    out = render(verdict, tmp_path, color=False, mode="full")
    assert "pricing:" not in out
```

- [ ] **Step 2: Run to verify failure**

```bash
uv run pytest tests/quorum/test_show.py -k footnote -v
```

Expected: FAIL (`"pricing: as of 2026-06-09" not in out`).

- [ ] **Step 3: Implement the footnote**

In `quorum/show.py`, inside `_format_economics_pane`, after the
`rows.append(f"  {'total':<10} ...")` line and before the `return`:

```python
    # Pricing provenance footnote (PRI-2130): which snapshot priced this run,
    # plus any approximations obol applied. Pre-obol verdicts have no nested
    # obol blocks and get no footnote.
    prov = ((econ.get("coding_agent") or {}).get("obol")
            or (econ.get("gauntlet") or {}).get("obol"))
    if prov and prov.get("pricing_as_of"):
        note = f"pricing: as of {prov['pricing_as_of']}"
        kinds: list[str] = []
        for block_key in ("coding_agent", "gauntlet"):
            for a in ((econ.get(block_key) or {}).get("obol") or {}).get(
                "approximations"
            ) or []:
                kind = a.get("kind")
                if kind and kind not in kinds:
                    kinds.append(kind)
        if kinds:
            note += " · " + ", ".join(kinds)
        rows.append(_style(f"  {note}", fg="bright_black", color=color))
```

- [ ] **Step 4: Run to verify pass**

```bash
uv run pytest tests/quorum/test_show.py -v
```

Expected: PASS (whole file).

- [ ] **Step 5: Commit**

```bash
git add quorum/show.py tests/quorum/test_show.py
git commit -m "feat: show pricing-provenance footnote in the economics pane (PRI-2130)"
```

---

### Task 8: Delete `token_usage.py`, sweep, full gate

**Files:**
- Delete: `quorum/token_usage.py`, `tests/quorum/test_token_usage.py`
- Modify: `docs/superpowers/specs/2026-06-09-quorum-obol-migration-design.md` (one deviation note)
- Modify: `CLAUDE.md` (architecture table)

- [ ] **Step 1: Delete**

```bash
git rm quorum/token_usage.py tests/quorum/test_token_usage.py
```

- [ ] **Step 2: Verify no stragglers**

```bash
grep -rn "token_usage\|PRICING_ASOF\|pricing_for_model\|estimate_cost_with\|capture_tokens\|backfill" --include="*.py" quorum/ tests/ setup_helpers/ bin/ || echo CLEAN
```

Expected: `CLEAN` (or only the string `coding-agent-token-usage.json`,
which is the artifact filename, not the module — keep those).

- [ ] **Step 3: Note the spec deviation**

In `docs/superpowers/specs/2026-06-09-quorum-obol-migration-design.md`,
"Frozen artifact schemas" section, after the bucket-mapping line, add:

```markdown
**Implementation deviation (2026-06-09):** `pricing_source` is omitted from
the artifacts — obol's Python binding does not expose it (the Rust core
serializes it, but `CostEstimate.from_json` drops the field). The footnote
renders from `pricing_as_of` alone. If the binding gains the field, thread
it through `obol_capture._merge_estimates`.
```

- [ ] **Step 4: Update CLAUDE.md architecture table**

In `CLAUDE.md`, the Architecture section: on the `quorum/capture.py` line,
change "token capture" to "obol-priced token capture", and add after it:

```markdown
- `quorum/obol_capture.py` — all obol calls: session-log + gauntlet-sidecar cost estimation, per-file merge.
- `quorum/timing.py` — session-log wall-clock span (`duration_ms`).
```

- [ ] **Step 5: Full gate**

```bash
uv run ruff format --check . && uv run ruff check && uv run ty check && uv run quorum check && uv run pytest -q
```

Expected: all green. Fix anything ruff/ty flags in the new modules before
committing (typical: unused imports left behind in `cli.py` or
`capture.py`).

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat!: delete token_usage.py — obol is the single cost engine (PRI-2130)"
```

---

### Task 9: Pre-merge verification (manual, trusted-maintainer)

Not CI. Requires `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` and a local
`SUPERPOWERS_ROOT`.

- [ ] **Step 1: Reconcile against the local corpus**

For recent run dirs under `results/` that preserved session logs, compare
the frozen pre-migration `est_cost_usd` against an obol recompute:

```bash
uv run python - <<'EOF'
import json
from pathlib import Path
from quorum.economics import _read_json
from quorum.obol_capture import estimate_session_logs

for vj in sorted(Path("results").rglob("verdict.json"))[-20:]:
    rd = vj.parent
    frozen = _read_json(rd / "coding-agent-token-usage.json")
    if not frozen:
        continue
    cfg = rd / "coding-agent-config"
    if (cfg / "projects").is_dir():
        backend, logs = "claude", sorted((cfg / "projects").rglob("*.jsonl"))
    elif (cfg / "sessions").is_dir():
        backend, logs = "codex", sorted((cfg / "sessions").rglob("rollout-*.jsonl"))
    else:
        continue
    est = estimate_session_logs(backend, logs)
    old, new = frozen.get("est_cost_usd"), est and est.get("est_cost_usd")
    print(f"{rd.name:<60} old={old} new={new}")
EOF
```

Expected: parity within snapshot drift (obol was validated against this
repo's numbers; codex runs will differ by the reasoning-tokens fix —
new ≥ old is expected there). Paste the output into the PR description.

- [ ] **Step 2: Live runs, one per agent**

```bash
uv run quorum run scenarios/<pick-one> --coding-agent claude
uv run quorum run scenarios/<pick-one> --coding-agent codex
uv run quorum show
```

Expected: economics pane shows both agents priced, plus the
`pricing: as of …` footnote; `verdict.json` carries nested `obol` blocks;
`partial: false`. If gauntlet's `usage.jsonl` is absent, the local
`gauntlet` checkout predates its sidecar (PRI-2125) — update it.

- [ ] **Step 3: PR**

Open the PR against `main` referencing PRI-2130 with the reconcile output.
After merge: the parent `superpowers` repo needs the `evals` submodule bump
PR against `dev` (repo convention — see CLAUDE.md).

---

## Self-review notes

- Spec coverage: dependency swap (T1), pricing fixture/hermetic tests (T2),
  timing helper (T3), obol_capture merge + sidecar + error table (T4),
  capture rewire (T5), economics + backfill deletion (T6), show footnote
  (T7), deletion/sweep + spec deviation (T8), reconcile + live runs (T9).
- `pricing_source` consciously deviates from the spec (binding limitation),
  documented in T8 Step 3.
- Type consistency: `estimate_session_logs(backend_family, files) -> dict | None`
  and `estimate_usage_sidecar(path) -> dict | None` are used with those exact
  signatures in T5/T6; bucket keys `total_input/total_cache_create/
  total_cache_read/total_output` are uniform across T4-T7.
