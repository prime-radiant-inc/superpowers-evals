# quorum run economics — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `quorum show`, `verdict.json`, and `run-all` report per-agent timing + cost (Gauntlet-Agent and Coding-Agent), computed at run time and frozen.

**Architecture:** A pure `quorum/economics.py` builds a `RunEconomics` dict from `result.json` (gauntlet) + `coding-agent-token-usage.json` (coding agent). The runner attaches it to the `FinalVerdict` (via `dataclasses.replace`) before writing `verdict.json`, so compose-logic is untouched and the cost freezes at run time. `token_usage.py` gains a model→pricing resolver (adds Sonnet) and captures the coding-agent's session-log timestamp span. `show.py` and `run_all.py` render the frozen numbers.

**Tech Stack:** Python 3.12+, pytest, `uv run pytest`. No new deps.

**Spec:** `docs/superpowers/specs/2026-05-28-quorum-run-economics-design.md`
**Ticket:** PRI-1872

---

## File map

**Create:**
- `quorum/economics.py` — `build_run_economics(run_dir) -> dict | None`
- `tests/quorum/test_economics.py`

**Modify:**
- `quorum/token_usage.py` — model→pricing resolver, Sonnet table, `PRICING_ASOF`; timestamp-span capture in both parsers + `capture_tokens`
- `tests/quorum/test_token_usage.py` — pricing resolver + timestamp tests
- `quorum/composer.py` — `FinalVerdict.economics` field + `to_dict`
- `tests/quorum/test_composer.py` — economics round-trips through `to_dict`
- `quorum/runner.py` — build economics, attach before writing verdict.json
- `quorum/show.py` — Economics pane
- `tests/quorum/test_show.py` — pane rendering
- `quorum/run_all.py` — cost column + batch total

---

## Background facts (verified)

- `result.json` (gauntlet): `duration_ms`, `usage.{inputTokens,outputTokens,cacheCreationInputTokens,cacheReadInputTokens}`, `config.model`.
- `coding-agent-token-usage.json` (existing): `total_input, total_cache_create, total_cache_read, total_output, total_tokens, model, n_assistant_turns, tool_result_total_bytes, est_cost_usd`, optional `cache_create_unavailable`.
- Codex rollout: top-level `timestamp` every line. Claude session JSONL: `timestamp` on `user`/`assistant`/`attachment` records only.
- `FinalVerdict` is a frozen dataclass with `to_dict()`; runner writes `verdict.json` at `runner.py:592`. `compose()` at `runner.py:584`.

---

## Task 1: Pricing resolver + Sonnet table in `token_usage.py`

**Files:** Modify `quorum/token_usage.py`, `tests/quorum/test_token_usage.py`

- [ ] **Step 1: Write failing tests**

Add to `tests/quorum/test_token_usage.py`:

```python
from quorum.token_usage import (
    PRICING_ASOF, pricing_for_model, estimate_cost_with,
    CLAUDE_SONNET_PRICING, CLAUDE_OPUS_PRICING, CODEX_GPT55_PRICING,
)

class TestPricingResolver:
    def test_opus_id_resolves_to_opus(self):
        assert pricing_for_model("claude-opus-4-7") is CLAUDE_OPUS_PRICING

    def test_sonnet_id_resolves_to_sonnet(self):
        assert pricing_for_model("claude-sonnet-4-6") is CLAUDE_SONNET_PRICING

    def test_gpt_id_resolves_to_codex(self):
        assert pricing_for_model("gpt-5.5") is CODEX_GPT55_PRICING

    def test_unknown_model_returns_none(self):
        assert pricing_for_model("gemini-3-pro") is None
        assert pricing_for_model(None) is None

    def test_estimate_cost_with_sonnet(self):
        usage = {"total_input": 1_000_000, "total_cache_create": 0,
                 "total_cache_read": 0, "total_output": 0}
        cost = estimate_cost_with(usage, CLAUDE_SONNET_PRICING)
        assert cost == CLAUDE_SONNET_PRICING["input_per_m"]

    def test_pricing_asof_is_set(self):
        assert isinstance(PRICING_ASOF, str) and PRICING_ASOF
```

- [ ] **Step 2: Run, verify fail**

Run: `uv run pytest tests/quorum/test_token_usage.py::TestPricingResolver -q`
Expected: ImportError / AttributeError.

- [ ] **Step 3: Implement**

In `quorum/token_usage.py`, after the existing pricing constants add:

```python
PRICING_ASOF = "2026-05"

# Anthropic Claude Sonnet 4.x list pricing per 1M tokens (USD).
CLAUDE_SONNET_PRICING: dict[str, float] = {
    "input_per_m": 3.0,
    "cache_create_per_m": 3.75,   # 1.25x base input
    "cache_read_per_m": 0.30,     # 0.1x base input
    "output_per_m": 15.0,
}


def pricing_for_model(model_id: str | None) -> dict[str, float] | None:
    """Resolve a per-1M pricing table from a model id by substring match.
    Returns None for unrecognized ids (caller renders cost as n/a)."""
    if not isinstance(model_id, str):
        return None
    m = model_id.lower()
    if "opus" in m:
        return CLAUDE_OPUS_PRICING
    if "sonnet" in m:
        return CLAUDE_SONNET_PRICING
    if "gpt" in m or "codex" in m:
        return CODEX_GPT55_PRICING
    return None


def estimate_cost_with(usage: dict[str, Any], pricing: dict[str, float]) -> float:
    """Cost in USD for a usage dict against an explicit pricing table.
    cache_create_per_m may be absent (OpenAI) — treated as 0 contribution."""
    return (
        usage.get("total_input", 0) * pricing["input_per_m"] / 1_000_000
        + usage.get("total_cache_create", 0) * pricing.get("cache_create_per_m", 0.0) / 1_000_000
        + usage.get("total_cache_read", 0) * pricing["cache_read_per_m"] / 1_000_000
        + usage.get("total_output", 0) * pricing["output_per_m"] / 1_000_000
    )
```

Note: the resolver is used **only for the gauntlet-agent** (which runs Claude Sonnet); the coding-agent cost is reused frozen and never routed through it. Don't add speculative clauses (e.g. a bare `o*` OpenAI matcher) — unmotivated here, and would mis-price real `o1`/`o3` ids if they ever fired. Leave the existing `estimate_claude_cost`/`estimate_codex_cost`/`capture_tokens` family path untouched — the coding-agent still uses it.

- [ ] **Step 4: Run, verify pass**

Run: `uv run pytest tests/quorum/test_token_usage.py -q`
Expected: PASS (new + existing).

- [ ] **Step 5: Commit**

```bash
git add quorum/token_usage.py tests/quorum/test_token_usage.py
git commit -m "feat(token_usage): model->pricing resolver + Sonnet table (PRI-1872)"
```

---

## Task 2: Capture coding-agent session-log duration in `token_usage.py`

**Files:** Modify `quorum/token_usage.py`, `tests/quorum/test_token_usage.py`

Both parsers must record the min/max ISO timestamp seen, and `capture_tokens` aggregates them into `first_ts`, `last_ts`, `duration_ms`.

- [ ] **Step 1: Write failing tests**

```python
class TestTimestampSpan:
    def test_claude_span(self, tmp_path):
        from quorum.token_usage import parse_claude_session
        p = tmp_path / "s.jsonl"
        p.write_text(
            # attachment: earliest timestamp, NO message dict — must still count
            json.dumps({"type": "attachment", "timestamp": "2026-05-28T09:59:50.000Z"}) + "\n"
            + json.dumps({"type": "assistant", "timestamp": "2026-05-28T10:00:00.000Z",
                          "message": {"role": "assistant", "usage": {"input_tokens": 1}}}) + "\n"
            + json.dumps({"type": "mode"}) + "\n"  # no timestamp — skipped
            + json.dumps({"type": "assistant", "timestamp": "2026-05-28T10:05:00.000Z",
                          "message": {"role": "assistant", "usage": {"output_tokens": 1}}}) + "\n"
        )
        u = parse_claude_session(p)
        # First ts comes from the attachment (no message dict) — proves the
        # timestamp is tracked before the message guard.
        assert u["first_ts"] == "2026-05-28T09:59:50.000Z"
        assert u["last_ts"] == "2026-05-28T10:05:00.000Z"

    def test_codex_span(self, tmp_path):
        from quorum.token_usage import parse_codex_rollout
        p = tmp_path / "r.jsonl"
        p.write_text(
            json.dumps({"timestamp": "2026-05-28T10:00:00.000Z", "type": "session_meta",
                        "payload": {"id": "x"}}) + "\n"
            + json.dumps({"timestamp": "2026-05-28T10:10:00.000Z", "type": "event_msg",
                          "payload": {"type": "agent_message"}}) + "\n"
        )
        u = parse_codex_rollout(p)
        assert u["first_ts"] == "2026-05-28T10:00:00.000Z"
        assert u["last_ts"] == "2026-05-28T10:10:00.000Z"

    def test_capture_tokens_duration_ms(self, tmp_path):
        from quorum.token_usage import capture_tokens
        p = tmp_path / "r.jsonl"
        p.write_text(
            json.dumps({"timestamp": "2026-05-28T10:00:00.000Z", "type": "session_meta", "payload": {"id": "x"}}) + "\n"
            + json.dumps({"timestamp": "2026-05-28T10:00:30.000Z", "type": "event_msg",
                          "payload": {"type": "token_count", "info": {"total_token_usage": {"total_tokens": 5}}}}) + "\n"
        )
        u = capture_tokens("codex", [p])
        assert u["duration_ms"] == 30_000
```

- [ ] **Step 2: Run, verify fail**

Run: `uv run pytest tests/quorum/test_token_usage.py::TestTimestampSpan -q`
Expected: KeyError on `first_ts`.

- [ ] **Step 3: Implement**

Add a helper near the top of `token_usage.py`:

```python
from datetime import datetime

def _track_ts(current_first: str | None, current_last: str | None, ts: Any) -> tuple[str | None, str | None]:
    """Fold an ISO timestamp into running (first, last). Ignores non-strings."""
    if not isinstance(ts, str) or not ts:
        return current_first, current_last
    first = ts if current_first is None or ts < current_first else current_first
    last = ts if current_last is None or ts > current_last else current_last
    return first, last
```

(ISO-8601 UTC strings with the same shape sort lexicographically, so string comparison gives correct ordering — no datetime parsing needed.)

In `parse_claude_session`: initialize `first_ts = last_ts = None`; call `first_ts, last_ts = _track_ts(first_ts, last_ts, rec.get("timestamp"))` **immediately after `rec = json.loads(line)` and BEFORE the `if not isinstance(message, dict): continue` guard** (`token_usage.py:~68`). This is load-bearing: `attachment` records carry a `timestamp` but have no `message` dict, so gating the timestamp on `message` drops them and shortens the span (verified ~10s head error on a real session). Add `"first_ts": first_ts, "last_ts": last_ts` to the returned dict.

In `parse_codex_rollout`: same — `rec.get("timestamp")` is top-level. Add the same two keys to the returned dict.

In `capture_tokens`, after building `summed`, aggregate across `valid`:

```python
firsts = [u["first_ts"] for u in valid if u.get("first_ts")]
lasts = [u["last_ts"] for u in valid if u.get("last_ts")]
first_ts = min(firsts) if firsts else None
last_ts = max(lasts) if lasts else None
duration_ms = None
if first_ts and last_ts:
    a = datetime.fromisoformat(first_ts.replace("Z", "+00:00"))
    b = datetime.fromisoformat(last_ts.replace("Z", "+00:00"))
    duration_ms = max(int((b - a).total_seconds() * 1000), 0)
summed["first_ts"] = first_ts
summed["last_ts"] = last_ts
summed["duration_ms"] = duration_ms
```

These land in `coding-agent-token-usage.json` automatically (it serializes `summed`).

- [ ] **Step 4: Run, verify pass**

Run: `uv run pytest tests/quorum/test_token_usage.py -q`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add quorum/token_usage.py tests/quorum/test_token_usage.py
git commit -m "feat(token_usage): capture coding-agent session-log duration span (PRI-1872)"
```

---

## Task 3: `quorum/economics.py`

**Files:** Create `quorum/economics.py`, `tests/quorum/test_economics.py`

- [ ] **Step 1: Write failing tests**

```python
# tests/quorum/test_economics.py
import json
from pathlib import Path
from quorum.economics import build_run_economics


def _gauntlet_result(run_dir: Path, *, model="claude-sonnet-4-6", duration_ms=120000):
    rid = "run-x"
    d = run_dir / "gauntlet-agent" / "results" / rid
    d.mkdir(parents=True)
    (d / "result.json").write_text(json.dumps({
        "runId": rid, "duration_ms": duration_ms,
        "usage": {"inputTokens": 100, "outputTokens": 200,
                  "cacheCreationInputTokens": 0, "cacheReadInputTokens": 1000},
        "config": {"model": model},
    }))


def _coding_usage(run_dir: Path, **over):
    payload = {"total_input": 50, "total_cache_create": 0, "total_cache_read": 0,
               "total_output": 80, "total_tokens": 130, "model": "gpt-5.5",
               "est_cost_usd": 1.23, "duration_ms": 90000}
    payload.update(over)
    (run_dir / "coding-agent-token-usage.json").write_text(json.dumps(payload))


def test_both_agents_present(tmp_path):
    _gauntlet_result(tmp_path); _coding_usage(tmp_path)
    econ = build_run_economics(tmp_path)
    assert econ["gauntlet"]["duration_ms"] == 120000
    assert econ["gauntlet"]["est_cost_usd"] is not None
    assert econ["coding_agent"]["duration_ms"] == 90000
    assert econ["coding_agent"]["est_cost_usd"] == 1.23
    assert econ["total_est_cost_usd"] == round(
        econ["gauntlet"]["est_cost_usd"] + 1.23, 6)
    assert econ["partial"] is False
    assert econ["pricing_asof"]


def test_missing_coding_usage_is_partial(tmp_path):
    _gauntlet_result(tmp_path)
    econ = build_run_economics(tmp_path)
    assert econ["coding_agent"] is None
    assert econ["partial"] is True
    assert econ["total_est_cost_usd"] is None


def test_missing_gauntlet_result_is_partial(tmp_path):
    _coding_usage(tmp_path)
    econ = build_run_economics(tmp_path)
    assert econ["gauntlet"] is None
    assert econ["partial"] is True


def test_unpriced_gauntlet_model_yields_null_cost(tmp_path):
    _gauntlet_result(tmp_path, model="gemini-3-pro"); _coding_usage(tmp_path)
    econ = build_run_economics(tmp_path)
    assert econ["gauntlet"]["est_cost_usd"] is None
    assert econ["gauntlet"]["tokens"]["total"] > 0
    # total is null because one side is unpriced
    assert econ["total_est_cost_usd"] is None
    assert econ["partial"] is True


def test_no_sources_returns_none(tmp_path):
    assert build_run_economics(tmp_path) is None
```

- [ ] **Step 2: Run, verify fail**

Run: `uv run pytest tests/quorum/test_economics.py -q`
Expected: ImportError.

- [ ] **Step 3: Implement**

```python
# quorum/economics.py
"""Per-run economics: timing + cost for both agents, computed at run time.

Reads the gauntlet-agent's result.json and the coding-agent's frozen
coding-agent-token-usage.json, applies pricing (gauntlet only — the
coding-agent cost is already frozen), and returns a JSON-shaped dict that
the runner persists into verdict.json. Renderers display it verbatim;
they never recompute. PRI-1872.
"""
from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from quorum.token_usage import PRICING_ASOF, pricing_for_model, estimate_cost_with


def _read_gauntlet_result(run_dir: Path) -> dict | None:
    base = run_dir / "gauntlet-agent" / "results"
    if not base.is_dir():
        return None
    for d in base.iterdir():
        rj = d / "result.json"
        if rj.is_file():
            try:
                return json.loads(rj.read_text())
            except (json.JSONDecodeError, OSError):
                return None
    return None


def _gauntlet_block(result: dict) -> dict:
    usage = result.get("usage") or {}
    tokens = {
        "input": int(usage.get("inputTokens", 0) or 0),
        "output": int(usage.get("outputTokens", 0) or 0),
        "cache_create": int(usage.get("cacheCreationInputTokens", 0) or 0),
        "cache_read": int(usage.get("cacheReadInputTokens", 0) or 0),
    }
    tokens["total"] = sum(tokens.values())
    model = (result.get("config") or {}).get("model")
    pricing = pricing_for_model(model)
    est = None
    if pricing is not None:
        est = round(estimate_cost_with({
            "total_input": tokens["input"],
            "total_output": tokens["output"],
            "total_cache_create": tokens["cache_create"],
            "total_cache_read": tokens["cache_read"],
        }, pricing), 6)
    dur = result.get("duration_ms")
    return {
        "duration_ms": int(dur) if isinstance(dur, (int, float)) else None,
        "model": model,
        "tokens": tokens,
        "est_cost_usd": est,
    }


def _coding_block(usage: dict) -> dict:
    return {
        "duration_ms": usage.get("duration_ms"),
        "model": usage.get("model"),
        "tokens": {
            "input": usage.get("total_input", 0),
            "output": usage.get("total_output", 0),
            "cache_create": usage.get("total_cache_create", 0),
            "cache_read": usage.get("total_cache_read", 0),
            "total": usage.get("total_tokens", 0),
        },
        "est_cost_usd": usage.get("est_cost_usd"),
    }


def build_run_economics(run_dir: Path) -> dict | None:
    """Build the economics block for verdict.json, or None if no source exists."""
    result = _read_gauntlet_result(run_dir)
    cu_path = run_dir / "coding-agent-token-usage.json"
    coding_usage = None
    if cu_path.is_file():
        try:
            coding_usage = json.loads(cu_path.read_text())
        except (json.JSONDecodeError, OSError):
            coding_usage = None

    if result is None and coding_usage is None:
        return None

    gauntlet = _gauntlet_block(result) if result is not None else None
    coding = _coding_block(coding_usage) if coding_usage is not None else None

    g_cost = gauntlet["est_cost_usd"] if gauntlet else None
    c_cost = coding["est_cost_usd"] if coding else None
    total = round(g_cost + c_cost, 6) if (g_cost is not None and c_cost is not None) else None

    partial = (gauntlet is None or coding is None
               or g_cost is None or c_cost is None)

    return {
        "pricing_asof": PRICING_ASOF,
        "gauntlet": gauntlet,
        "coding_agent": coding,
        "total_est_cost_usd": total,
        "partial": partial,
    }
```

- [ ] **Step 4: Run, verify pass**

Run: `uv run pytest tests/quorum/test_economics.py -q`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add quorum/economics.py tests/quorum/test_economics.py
git commit -m "feat(economics): build_run_economics for both agents (PRI-1872)"
```

---

## Task 4: `FinalVerdict.economics` field

**Files:** Modify `quorum/composer.py`, `tests/quorum/test_composer.py`

- [ ] **Step 1: Write failing test**

```python
def test_finalverdict_serializes_economics():
    from quorum.composer import FinalVerdict
    econ = {"pricing_asof": "2026-05", "total_est_cost_usd": 1.5, "partial": False,
            "gauntlet": None, "coding_agent": None}
    v = FinalVerdict(final="pass", economics=econ)
    d = v.to_dict()
    assert d["economics"] == econ

def test_finalverdict_economics_defaults_none():
    from quorum.composer import FinalVerdict
    assert FinalVerdict().to_dict()["economics"] is None
```

- [ ] **Step 2: Run, verify fail**

Run: `uv run pytest tests/quorum/test_composer.py -k economics -q`
Expected: TypeError (unexpected kwarg) / KeyError.

- [ ] **Step 3: Implement**

In `quorum/composer.py` `FinalVerdict`, add a field (after `error`):

```python
    economics: dict | None = None
```

In `to_dict()`, add to the returned dict:

```python
            "economics": self.economics,
```

`compose()` is unchanged — economics is attached by the runner after compose (Task 5). All existing `FinalVerdict(...)` constructions keep working (new field defaults None).

- [ ] **Step 4: Run, verify pass**

Run: `uv run pytest tests/quorum/test_composer.py -q`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add quorum/composer.py tests/quorum/test_composer.py
git commit -m "feat(composer): FinalVerdict.economics field, serialized in verdict.json (PRI-1872)"
```

---

## Task 5: Wire economics into the runner

**Files:** Modify `quorum/runner.py`

The runner computes economics at run time and attaches it to the verdict before writing `verdict.json` (`runner.py:584-593`).

- [ ] **Step 1: Add the import**

At the top with the other `from quorum.*` imports:

```python
import dataclasses
from quorum.economics import build_run_economics
```

- [ ] **Step 2: Attach after compose**

Replace the block at `runner.py:584-593` (the `verdict = compose(...)` through the `verdict.json` write) so economics is folded in:

```python
    verdict = compose(
        gauntlet=gauntlet_layer,
        checks=pre_records + post_records,   # ← keep EXACTLY as the existing call (runner.py:586); do not change to post_records only
        capture_empty=capture_empty,
        error=None,
    )
    economics = build_run_economics(run_dir)
    if economics is not None:
        verdict = dataclasses.replace(verdict, economics=economics)
    (run_dir / "verdict.json").write_text(
        json.dumps(verdict.to_dict(), indent=2)
    )
```

**Critical:** do not retype the `compose(...)` call from memory — read `runner.py:584-590` and add *only* the three new lines (`economics = …`, the `if`, and the `replace`). The existing call passes `checks=pre_records + post_records`; preserving it is mandatory or pre-checks vanish from the verdict.

- [ ] **Step 3: Verify the existing runner tests still pass**

Run: `uv run pytest tests/quorum/test_runner.py -q`
Expected: PASS. The happy-path test now writes a `verdict.json` whose `economics` is null (the stub gauntlet writes no `result.json` usage and there's no token-usage file) — acceptable; economics is `None` → not attached.

- [ ] **Step 4: Add a runner test asserting economics lands in verdict.json**

```python
def test_verdict_carries_economics_when_sources_present(self, tmp_path):
    # Build a run where invoke_gauntlet stub writes a result.json with usage,
    # and a coding-agent-token-usage.json exists. Assert verdict.json.economics
    # is populated. (Mirror the _stub that writes .gauntlet/results, but also
    # write gauntlet-agent/results/<id>/result.json + coding-agent-token-usage.json.)
```

Implement using the existing `run_scenario` + stub pattern in `test_runner.py`; the stub's `run_dir` is where you write the two source files before returning "pass". Assert `json.loads((rd/"verdict.json").read_text())["economics"]["total_est_cost_usd"]` is a float.

- [ ] **Step 5: Run, verify pass; commit**

```bash
uv run pytest tests/quorum/test_runner.py -q
git add quorum/runner.py tests/quorum/test_runner.py
git commit -m "feat(runner): attach run economics to verdict at run time (PRI-1872)"
```

---

## Task 6: Economics pane in `quorum show`

**Files:** Modify `quorum/show.py`, `tests/quorum/test_show.py`

- [ ] **Step 1: Write failing test**

```python
def test_render_includes_economics_pane():
    from quorum.show import render
    verdict = {
        "final": "pass", "final_reason": "ok",
        "gauntlet": {"status": "pass", "summary": "", "reasoning": ""},
        "checks": [],
        "economics": {
            "pricing_asof": "2026-05",
            "gauntlet": {"duration_ms": 1885117, "model": "claude-sonnet-4-6",
                         "tokens": {"total": 7100000}, "est_cost_usd": 0.42},
            "coding_agent": {"duration_ms": 1443000, "model": "gpt-5.5",
                             "tokens": {"total": 2300000}, "est_cost_usd": 1.85},
            "total_est_cost_usd": 2.27, "partial": False,
        },
    }
    out = render(verdict, Path("/tmp/run"), color=False, mode="full")
    assert "Economics" in out
    assert "$2.27" in out
    assert "Gauntlet" in out and "Coding" in out

def test_render_economics_absent_is_safe():
    from quorum.show import render
    verdict = {"final": "pass", "final_reason": "", "gauntlet": {"status": "pass"},
               "checks": []}  # no economics key
    out = render(verdict, Path("/tmp/run"), color=False, mode="full")
    assert isinstance(out, str)  # no crash
```

Note: `ShowMode` is a `Literal["full","quiet","json"]`, NOT an enum — pass the string `"full"`, not `ShowMode.FULL`. Match the `render` signature already used in `test_show.py`.

- [ ] **Step 2: Run, verify fail**

Run: `uv run pytest tests/quorum/test_show.py -k economics -q`
Expected: FAIL (no "Economics" in output).

- [ ] **Step 3: Implement**

Add `_format_economics_pane(verdict, *, color)` to `show.py` and include it in the `render()` assembly (after the checks pane). Use the existing `_style`/`_label` helpers and `_fmt_duration` if present, else format ms→`Hh Mm Ss` locally.

```python
def _fmt_ms(ms: int | None) -> str:
    if not ms:
        return "—"
    s = int(ms) // 1000
    h, rem = divmod(s, 3600)
    m, sec = divmod(rem, 60)
    return (f"{h}h {m:02d}m" if h else f"{m}m {sec:02d}s")

def _fmt_cost(c) -> str:
    return f"${c:.2f}" if isinstance(c, (int, float)) else "n/a"

def _fmt_tokens(n) -> str:
    if not isinstance(n, (int, float)) or n == 0:
        return "—"
    return f"{n/1_000_000:.1f}M" if n >= 1_000_000 else f"{n/1_000:.0f}K"

def _agent_row(label, block, *, color):
    if not block:
        return f"  {label:<10} {'—':>10} {'—':>9} {'—':>9}"
    dur = _fmt_ms(block.get("duration_ms"))
    tok = _fmt_tokens((block.get('tokens') or {}).get('total'))
    cost = _fmt_cost(block.get("est_cost_usd"))
    if block.get("est_cost_usd") is None and block.get("model"):
        cost = f"n/a ({block['model']})"
    return f"  {label:<10} {dur:>10} {tok:>9} {cost:>9}"

def _format_economics_pane(verdict: dict, *, color: bool) -> str:
    econ = verdict.get("economics")
    if not econ:
        return ""
    sep = _style("─── Economics ────────────────────────────────────",
                 fg="bright_cyan", bold=True, color=color)
    header = f"  {'':<10} {'duration':>10} {'tokens':>9} {'est cost':>9}"
    rows = [
        _agent_row("Gauntlet", econ.get("gauntlet"), color=color),
        _agent_row("Coding", econ.get("coding_agent"), color=color),
    ]
    total = econ.get("total_est_cost_usd")
    total_str = _fmt_cost(total) if total is not None else ("partial" if econ.get("partial") else "—")
    rows.append(f"  {'total':<10} {'':>10} {'':>9} {total_str:>9}")
    return "\n".join([sep, header, *rows]) + "\n"
```

In `render()`, append `_format_economics_pane(verdict, color=color)` to the `parts` list (only adds output when economics present — returns "" otherwise).

- [ ] **Step 4: Run, verify pass**

Run: `uv run pytest tests/quorum/test_show.py -q`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add quorum/show.py tests/quorum/test_show.py
git commit -m "feat(show): Economics pane with per-agent timing + cost (PRI-1872)"
```

---

## Task 7: Cost column + batch total in `run-all`

**Files:** Modify `quorum/run_all.py`

`run-all` already prints per-run wall-clock. Add an est-cost cell per run and a batch cost total in the footer. Cost is read from each run's `verdict.json["economics"]["total_est_cost_usd"]` (frozen — no recompute).

- [ ] **Step 1: Add a cost helper + read per-run cost**

In the `_drain` result loop (around `run_all.py:496-509`), after computing `duration`, read the run's economics. The run dir is `out_root / result.run_id` — exactly what the existing `_final_status_for_result` uses (`run_all.py:605`), and there's already a `_read_verdict(run_dir)` helper (`run_all.py:569`). **Reuse `_read_verdict`** rather than re-opening the file:

```python
def _run_cost(run_dir: Path) -> float | None:
    verdict = _read_verdict(run_dir)   # existing helper at run_all.py:569
    if not verdict:
        return None
    return (verdict.get("economics") or {}).get("total_est_cost_usd")
```

For the cost cell formatting, `_fmt_cost` lives in `show.py` — **import it** (`from quorum.show import _fmt_cost`) rather than duplicating, so the `$1.23`/`n/a` formatting stays in one place. Append a right-aligned cost cell to the `Text.assemble(...)` line (mirror the `{duration:>{_DUR_COL_W}}` pattern). Accumulate a running `batch_cost_total` (sum of non-null per-run costs) under `print_lock`.

- [ ] **Step 2: Add batch total to the footer**

In the `summary_line` assembly (around `run_all.py:543-551`), append `· cost ${batch_cost_total:.2f}` when `batch_cost_total > 0`.

- [ ] **Step 3: Test**

Add/extend a `run_all` test (see `tests/quorum/test_run_all.py`) that runs a tiny batch where verdict.json carries economics, and assert the printed/captured output includes a `$` cost figure and the footer total. If the existing run_all tests stub at a level above rendering, assert on `_run_cost` directly with a synthesized run dir.

- [ ] **Step 4: Run, verify pass; commit**

```bash
uv run pytest tests/quorum/test_run_all.py -q
git add quorum/run_all.py tests/quorum/test_run_all.py
git commit -m "feat(run-all): per-run cost column + batch cost total (PRI-1872)"
```

---

## Task 8: Full-suite verification

- [ ] **Step 1:** `uv run pytest tests/quorum/ -q` → all green (1 pre-existing skip is fine).
- [ ] **Step 2:** Manual smoke on a real run dir:
  ```bash
  uv run quorum show <a-recent-run-dir>
  ```
  Confirm the Economics pane renders with both agents and a total.
- [ ] **Step 3:** No commit unless the smoke surfaces a fix.

---

## Self-review checklist

1. **Spec coverage:** economics in verdict.json (T4/5) ✓; gauntlet cost via Sonnet pricing (T1/3) ✓; coding cost reused + duration captured (T2/3) ✓; total sums, time doesn't (T3) ✓; pricing_asof (T1/3) ✓; show pane (T6) ✓; run-all column+total (T7) ✓; run-time freeze (T5, composer untouched) ✓; partial/`—`/`n/a` (T3/T6) ✓.
2. **Placeholder scan:** none — every code step has real code; T5/T7 reference exact line anchors + the existing stub/format patterns to match.
3. **Type consistency:** `build_run_economics -> dict | None`; `FinalVerdict.economics: dict | None`; `pricing_for_model -> dict | None`; `estimate_cost_with(usage, pricing) -> float`. Consistent across tasks.
