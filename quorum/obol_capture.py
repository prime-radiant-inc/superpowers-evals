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
            "est_cost_usd": None if m in unpriced else b["subtotal_usd"],
        }
        for m, b in per_model.items()
    }
    top_model = (
        max(per_model, key=lambda m: per_model[m]["subtotal_usd"], default=None)
        if per_model
        else None
    )

    return {
        **totals,
        "total_tokens": total_tokens,
        "model": top_model,
        "models": models_out,
        "est_cost_usd": None if all_unpriced else total_usd,
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
