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
    return {
        "duration_ms": int(dur) if isinstance(dur, (int, float)) else None,
        "model": model,
        "tokens": _tokens_shell(usage or {}),
        "est_cost_usd": (usage or {}).get("est_cost_usd"),
        "obol": _obol_provenance(usage) if usage else None,
    }


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
