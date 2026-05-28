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

from quorum.token_usage import PRICING_ASOF, estimate_cost_with, pricing_for_model


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
