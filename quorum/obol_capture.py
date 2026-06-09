"""All quorum↔obol traffic: estimate session logs / usage sidecars, merge, re-shape.

obol owns parsing and pricing (PRI-2130); this module owns the quorum-side
dict shape that freezes into run artifacts. estimate_path is single-file, so
multi-file runs (Claude subagents write sibling JSONLs) merge here — plain
addition over obol's outputs, never token math of our own.

Capture is best-effort measurement: expected failure paths return None —
never a silent $0. (Only ObolError is caught; exotic OS errors can still
propagate.) Line-oriented dialect parsers skip unparseable content (a garbage sibling
file contributes zero, matching pre-obol behavior); ObolError covers
structural failures like missing pricing tables or sidecar schema rejection.
"""
from __future__ import annotations

from pathlib import Path
from typing import Any

import obol

# quorum normalizer name -> obol dialect. Covers every backend dialect obol
# knows (the eighth, `obol`, is the sidecar format, not a backend); backends
# absent here (antigravity) simply aren't priced. A mapped backend whose log
# format diverges from obol's parser degrades to None at parse time, so
# listing one costs nothing.
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
                # first file's provider label wins for a model seen in several files
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
    if total_tokens == 0:
        return None  # zero usage -> no artifact, even if obol named models

    total_usd = sum(b["subtotal_usd"] for b in per_model.values())
    # Exact, and consistent with the per-model est_cost_usd field below: a
    # genuinely-$0-priced model (free tier) must not flip the run to unpriced.
    all_unpriced = bool(per_model) and all(m in unpriced for m in per_model)

    models_out = {
        m: {
            **{k: b[k] for k in _BUCKET_KEYS},
            "total_tokens": sum(b[k] for k in _BUCKET_KEYS),
            "provider": b["provider"],
            # round(…, 10): strips float-summation noise from frozen artifacts
            # without losing sub-cent precision (plan said 6; that truncated small costs).
            "est_cost_usd": None if m in unpriced else round(b["subtotal_usd"], 10),
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
        "est_cost_usd": None if all_unpriced else round(total_usd, 10),
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
