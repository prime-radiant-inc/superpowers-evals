"""Backend-aware token usage capture from session logs.

Parses Claude Code session JSONL or Codex rollout JSONL and returns a
normalized token-usage dict with cost estimates. Designed to be called from
the engine after a run completes so each result directory carries reproducible
per-run cost data.

Pricing constants are official published list pricing, sourced (not guessed):
- Anthropic: https://platform.claude.com/docs/en/about-claude/pricing
- OpenAI:    https://openai.com/api/pricing/
Verified 2026-05-28 (see PRICING_ASOF). Update from those pages when rates
move — do NOT eyeball or carry forward old-tier numbers (Opus 4.5+ dropped to
$5/$25 from the Opus-4.1 $15/$75; a stale constant once inflated cost ~3x).
"""

from __future__ import annotations

import json
import math
from datetime import datetime
from pathlib import Path
from typing import Any


def _track_ts(
    current_first: str | None, current_last: str | None, ts: Any
) -> tuple[str | None, str | None]:
    """Fold an ISO timestamp into running (first, last). Ignores non-strings."""
    if not isinstance(ts, str) or not ts:
        return current_first, current_last
    first = ts if current_first is None or ts < current_first else current_first
    last = ts if current_last is None or ts > current_last else current_last
    return first, last


def _track_numeric_ts(
    current_first: int | None, current_last: int | None, ts: Any
) -> tuple[int | None, int | None]:
    """Fold a numeric epoch-ish timestamp into running (first, last)."""
    value = _coerce_numeric_int(ts)
    if value is None:
        return current_first, current_last
    first = value if current_first is None or value < current_first else current_first
    last = value if current_last is None or value > current_last else current_last
    return first, last


def _coerce_numeric_int(value: Any) -> int | None:
    if isinstance(value, bool):
        return None
    if isinstance(value, int | float):
        number = float(value)
    elif isinstance(value, str):
        try:
            number = float(value.strip())
        except ValueError:
            return None
    else:
        return None
    if not math.isfinite(number):
        return None
    return int(number)


def _coerce_token_count(value: Any) -> int:
    number = _coerce_numeric_int(value)
    if number is None:
        return 0
    return max(number, 0)


# Anthropic Claude Opus 4.5/4.6/4.7/4.8 list pricing per 1M tokens (USD).
# platform.claude.com/docs/en/about-claude/pricing — Opus 4.5+ is $5/$25,
# NOT the Opus-4.1-and-earlier $15/$75. cache_create uses the 5-minute write
# rate (1.25x input); cache_read is the cache-hit rate (0.1x input).
CLAUDE_OPUS_PRICING: dict[str, float] = {
    "input_per_m": 5.0,
    "cache_create_per_m": 6.25,   # 5m cache write = 1.25x base input
    "cache_read_per_m": 0.50,     # cache hit = 0.1x base input
    "output_per_m": 25.0,
}

# OpenAI GPT-5.5 list pricing per 1M tokens (USD). openai.com/api/pricing
# Codex runs report model "gpt-5.5". OpenAI bills cached input (read) but not
# cache writes separately; cache_create stays 0 (see parse_codex_rollout).
# (Long-context tier >272K tokens is pricier; not modeled — runs here are under
# the 258K context window.)
CODEX_GPT55_PRICING: dict[str, float] = {
    "input_per_m": 5.0,
    "cache_read_per_m": 0.50,
    "output_per_m": 30.0,
}

PRICING_ASOF = "2026-05-28"

# Anthropic Claude Sonnet 4.x list pricing per 1M tokens (USD).
CLAUDE_SONNET_PRICING: dict[str, float] = {
    "input_per_m": 3.0,
    "cache_create_per_m": 3.75,   # 1.25x base input
    "cache_read_per_m": 0.30,     # 0.1x base input
    "output_per_m": 15.0,
}

# Anthropic Claude Haiku 4.5 list pricing per 1M tokens (USD).
CLAUDE_HAIKU_PRICING: dict[str, float] = {
    "input_per_m": 1.0,
    "cache_create_per_m": 1.25,   # 1.25x base input
    "cache_read_per_m": 0.10,     # 0.1x base input
    "output_per_m": 5.0,
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
    if "haiku" in m:
        return CLAUDE_HAIKU_PRICING
    if "gpt" in m or "codex" in m:
        return CODEX_GPT55_PRICING
    return None


_MODEL_TOKEN_KEYS = (
    "total_input", "total_cache_create", "total_cache_read", "total_output",
)


def _empty_model_bucket() -> dict[str, int]:
    return {k: 0 for k in _MODEL_TOKEN_KEYS} | {"n_assistant_turns": 0}


def estimate_cost_with(usage: dict[str, Any], pricing: dict[str, float]) -> float:
    """Cost in USD for a usage dict against an explicit pricing table.
    cache_create_per_m may be absent (OpenAI) — treated as 0 contribution."""
    return (
        usage.get("total_input", 0) * pricing["input_per_m"] / 1_000_000
        + usage.get("total_cache_create", 0) * pricing.get("cache_create_per_m", 0.0) / 1_000_000
        + usage.get("total_cache_read", 0) * pricing["cache_read_per_m"] / 1_000_000
        + usage.get("total_output", 0) * pricing["output_per_m"] / 1_000_000
    )


def parse_claude_session(path: Path) -> dict[str, Any] | None:
    """Sum Claude Code per-message usage across one session JSONL.

    CC writes one JSON object per line. Assistant messages carry a `usage`
    block with `input_tokens`, `cache_creation_input_tokens`,
    `cache_read_input_tokens`, and `output_tokens`. Some assistant messages
    (e.g., final synthetic ones) lack a usage block - skip them gracefully.

    Tool result content blocks live on user messages and may be a string or a
    list of `{type: text, text: ...}` blocks; sum the UTF-8 byte length of
    every text payload to expose tool-output bloat as a first-class metric.
    """
    if not path.exists():
        return None

    tool_result_total_bytes = 0
    model: str | None = None
    first_ts: str | None = None
    last_ts: str | None = None
    # Dedup by message.id: Claude Code logs ONE record per content block
    # within an assistant message (a text block, then each tool_use block),
    # and every record repeats the message's full `usage`. Summing per-record
    # multi-counts each API call by its block count. Key by message.id and
    # keep the LAST record's usage — output_tokens grows as the message
    # streams, so the final record carries the complete usage. PRI-1872.
    msg_usage: dict[str, dict[str, Any]] = {}
    anon_turns: list[dict[str, Any]] = []  # assistant records with no id

    with path.open() as f:
        for line in f:
            if not line.strip():
                continue
            try:
                rec = json.loads(line)
            except json.JSONDecodeError:
                continue
            first_ts, last_ts = _track_ts(first_ts, last_ts, rec.get("timestamp"))
            rec_type = rec.get("type")
            message = rec.get("message")
            if not isinstance(message, dict):
                continue

            if rec_type == "assistant":
                if model is None and isinstance(message.get("model"), str):
                    model = message.get("model")
                usage = message.get("usage")
                if not isinstance(usage, dict):
                    usage = {}
                model = message.get("model")
                entry = {
                    "model": model if isinstance(model, str) else "unknown",
                    "total_input": int(usage.get("input_tokens", 0) or 0),
                    "total_cache_create": int(usage.get("cache_creation_input_tokens", 0) or 0),
                    "total_cache_read": int(usage.get("cache_read_input_tokens", 0) or 0),
                    "total_output": int(usage.get("output_tokens", 0) or 0),
                }
                mid = message.get("id")
                if isinstance(mid, str):
                    msg_usage[mid] = entry  # last write wins (complete usage)
                else:
                    anon_turns.append(entry)

            elif rec_type == "user":
                content = message.get("content")
                if isinstance(content, list):
                    for block in content:
                        if isinstance(block, dict) and block.get("type") == "tool_result":
                            tool_result_total_bytes += _byte_len_of_tool_result(
                                block.get("content")
                            )

    total_input = total_cache_create = total_cache_read = total_output = 0
    n_assistant_turns = 0
    by_model: dict[str, dict[str, int]] = {}
    for entry in (*msg_usage.values(), *anon_turns):
        total_input += entry["total_input"]
        total_cache_create += entry["total_cache_create"]
        total_cache_read += entry["total_cache_read"]
        total_output += entry["total_output"]
        n_assistant_turns += 1
        bucket = by_model.setdefault(entry["model"], _empty_model_bucket())
        bucket["n_assistant_turns"] += 1
        bucket["total_input"] += entry["total_input"]
        bucket["total_cache_create"] += entry["total_cache_create"]
        bucket["total_cache_read"] += entry["total_cache_read"]
        bucket["total_output"] += entry["total_output"]

    return {
        "total_input": total_input,
        "total_cache_create": total_cache_create,
        "total_cache_read": total_cache_read,
        "total_output": total_output,
        "total_tokens": total_input + total_cache_create + total_cache_read + total_output,
        "model": model,
        "n_assistant_turns": n_assistant_turns,
        "tool_result_total_bytes": tool_result_total_bytes,
        "first_ts": first_ts,
        "last_ts": last_ts,
        "by_model": by_model,
    }


def parse_codex_rollout(path: Path) -> dict[str, Any] | None:
    """Sum Codex token usage from one rollout JSONL.

    Codex emits cumulative `total_token_usage` inside `event_msg` /
    `token_count` payloads on every turn - the LAST one in the file is the
    session total. `cached_input_tokens` is a SUBSET of `input_tokens`, so
    uncached input = input_tokens - cached_input_tokens. OpenAI does not
    expose cache writes; we set `total_cache_create=0` and flag this with
    `cache_create_unavailable=True` so the column means the same thing as the
    CC column even though the underlying number is structurally missing.

    `function_call_output.output` is a string containing the raw tool result
    (shell stdout, file contents, etc.); sum UTF-8 byte length to mirror the
    CC tool_result_total_bytes metric.
    """
    if not path.exists():
        return None

    last_total: dict[str, Any] | None = None
    n_assistant_turns = 0
    tool_result_total_bytes = 0
    model: str | None = None
    first_ts: str | None = None
    last_ts: str | None = None

    with path.open() as f:
        for line in f:
            if not line.strip():
                continue
            try:
                rec = json.loads(line)
            except json.JSONDecodeError:
                continue
            first_ts, last_ts = _track_ts(first_ts, last_ts, rec.get("timestamp"))
            rec_type = rec.get("type")
            payload = rec.get("payload") or {}
            if not isinstance(payload, dict):
                continue

            if rec_type == "turn_context":
                m = payload.get("model")
                if isinstance(m, str) and model is None:
                    model = m

            elif rec_type == "event_msg":
                ptype = payload.get("type")
                if ptype == "token_count":
                    info = payload.get("info") or {}
                    total = info.get("total_token_usage")
                    if isinstance(total, dict):
                        last_total = total
                elif ptype == "agent_message":
                    n_assistant_turns += 1

            elif rec_type == "response_item":
                ptype = payload.get("type")
                if ptype == "function_call_output":
                    output = payload.get("output")
                    if isinstance(output, str):
                        tool_result_total_bytes += len(output.encode("utf-8"))

    if last_total is None:
        input_tokens = cached = output_tokens = total_tokens = 0
    else:
        input_tokens = int(last_total.get("input_tokens", 0) or 0)
        cached = int(last_total.get("cached_input_tokens", 0) or 0)
        output_tokens = int(last_total.get("output_tokens", 0) or 0)
        total_tokens = int(last_total.get("total_tokens", 0) or 0)

    total_input_uncached = max(input_tokens - cached, 0)
    by_model = {
        (model if isinstance(model, str) else "unknown"): {
            "total_input": total_input_uncached,
            "total_cache_create": 0,
            "total_cache_read": cached,
            "total_output": output_tokens,
            "n_assistant_turns": n_assistant_turns,
        }
    }
    return {
        "total_input": total_input_uncached,
        "total_cache_create": 0,
        "total_cache_read": cached,
        "total_output": output_tokens,
        "total_tokens": total_tokens,
        "model": model,
        "n_assistant_turns": n_assistant_turns,
        "tool_result_total_bytes": tool_result_total_bytes,
        "cache_create_unavailable": True,
        "first_ts": first_ts,
        "last_ts": last_ts,
        "by_model": by_model,
    }


def parse_kimi_wire(path: Path) -> dict[str, Any] | None:
    """Sum Kimi Code `usage.record` rows from one wire.jsonl file.

    Kimi emits both per-turn and cumulative session usage rows. Prefer turn
    rows when present so capture does not double-count the same session.
    """
    if not path.exists():
        return None

    turn_rows: list[dict[str, Any]] = []
    session_rows: list[dict[str, Any]] = []
    with path.open() as f:
        for line in f:
            if not line.strip():
                continue
            try:
                row = json.loads(line)
            except json.JSONDecodeError:
                continue
            if not isinstance(row, dict) or row.get("type") != "usage.record":
                continue
            if row.get("usageScope") == "turn":
                turn_rows.append(row)
            elif row.get("usageScope") == "session":
                session_rows.append(row)

    selected = turn_rows
    usage_source = "turn"
    if not selected and session_rows:
        selected = [
            max(
                session_rows,
                key=lambda row: _coerce_numeric_int(row.get("time")) or -1,
            )
        ]
        usage_source = "session_fallback"
    if not selected:
        return None

    first_ts: int | None = None
    last_ts: int | None = None
    by_model: dict[str, dict[str, int]] = {}
    totals = _empty_model_bucket()
    model: str | None = None

    for row in selected:
        first_ts, last_ts = _track_numeric_ts(first_ts, last_ts, row.get("time"))
        raw_model = row.get("model")
        model_id = raw_model if isinstance(raw_model, str) else "unknown"
        model = model or model_id
        raw_usage = row.get("usage")
        usage: dict[str, Any] = raw_usage if isinstance(raw_usage, dict) else {}
        entry = {
            "total_input": _coerce_token_count(usage.get("inputOther")),
            "total_cache_read": _coerce_token_count(usage.get("inputCacheRead")),
            "total_cache_create": _coerce_token_count(usage.get("inputCacheCreation")),
            "total_output": _coerce_token_count(usage.get("output")),
        }
        bucket = by_model.setdefault(model_id, _empty_model_bucket())
        for key, value in entry.items():
            totals[key] += value
            bucket[key] += value
        if row.get("usageScope") == "turn":
            totals["n_assistant_turns"] += 1
            bucket["n_assistant_turns"] += 1

    duration_ms = None
    if first_ts is not None and last_ts is not None:
        duration_ms = max(last_ts - first_ts, 0)
    return {
        **totals,
        "total_tokens": sum(totals[k] for k in _MODEL_TOKEN_KEYS),
        "model": model,
        "tool_result_total_bytes": 0,
        "first_ts": first_ts,
        "last_ts": last_ts,
        "duration_ms": duration_ms,
        "by_model": by_model,
        "usage_source": usage_source,
    }


def estimate_claude_cost(usage: dict[str, Any]) -> float:
    """Cost in USD using Claude Opus 4.x list pricing."""
    p = CLAUDE_OPUS_PRICING
    return (
        usage.get("total_input", 0) * p["input_per_m"] / 1_000_000
        + usage.get("total_cache_create", 0) * p["cache_create_per_m"] / 1_000_000
        + usage.get("total_cache_read", 0) * p["cache_read_per_m"] / 1_000_000
        + usage.get("total_output", 0) * p["output_per_m"] / 1_000_000
    )


def estimate_codex_cost(usage: dict[str, Any]) -> float:
    """Cost in USD using GPT-5.5 list pricing (cached input billed separately)."""
    p = CODEX_GPT55_PRICING
    return (
        usage.get("total_input", 0) * p["input_per_m"] / 1_000_000
        + usage.get("total_cache_read", 0) * p["cache_read_per_m"] / 1_000_000
        + usage.get("total_output", 0) * p["output_per_m"] / 1_000_000
    )


def capture_tokens(
    backend_family: str,
    session_log_files: list[Path],
) -> dict[str, Any] | None:
    """Aggregate token usage across all session log files for a single run.

    Claude Code spawns subagents into separate JSONL files inside the same
    project dir; we sum across all of them so the returned cost reflects the
    full run. Codex writes one rollout per session, but the engine may have
    collected several if filtering missed something - we still aggregate.
    """
    if backend_family == "claude":
        per_file = [parse_claude_session(p) for p in session_log_files]
    elif backend_family == "codex":
        per_file = [parse_codex_rollout(p) for p in session_log_files]
    elif backend_family == "kimi":
        per_file = [parse_kimi_wire(p) for p in session_log_files]
    else:
        return None

    valid = [u for u in per_file if u is not None]
    if not valid:
        return None

    summed: dict[str, Any] = {
        "total_input": sum(u["total_input"] for u in valid),
        "total_cache_create": sum(u["total_cache_create"] for u in valid),
        "total_cache_read": sum(u["total_cache_read"] for u in valid),
        "total_output": sum(u["total_output"] for u in valid),
        "total_tokens": sum(u["total_tokens"] for u in valid),
        "n_assistant_turns": sum(u["n_assistant_turns"] for u in valid),
        "tool_result_total_bytes": sum(u["tool_result_total_bytes"] for u in valid),
        "model": next((u["model"] for u in valid if u.get("model")), None),
    }

    firsts = [u["first_ts"] for u in valid if u.get("first_ts")]
    lasts = [u["last_ts"] for u in valid if u.get("last_ts")]
    first_ts = min(firsts) if firsts else None
    last_ts = max(lasts) if lasts else None
    duration_ms = None
    if first_ts and last_ts:
        if isinstance(first_ts, int | float) and isinstance(last_ts, int | float):
            duration_ms = max(int(last_ts - first_ts), 0)
        elif isinstance(first_ts, str) and isinstance(last_ts, str):
            a = datetime.fromisoformat(first_ts.replace("Z", "+00:00"))
            b = datetime.fromisoformat(last_ts.replace("Z", "+00:00"))
            duration_ms = max(int((b - a).total_seconds() * 1000), 0)
    summed["first_ts"] = first_ts
    summed["last_ts"] = last_ts
    summed["duration_ms"] = duration_ms

    # Per-model cost. A single run is multi-model (main agent + subagents on
    # different models); pricing the summed token pool at one model's rate
    # over- or under-states cost. Aggregate by model, price each separately,
    # and sum (PRI-1872).
    agg: dict[str, dict[str, int]] = {}
    for u in valid:
        for m, bucket in (u.get("by_model") or {}).items():
            dst = agg.setdefault(m, _empty_model_bucket())
            for k in _MODEL_TOKEN_KEYS:
                dst[k] += int(bucket.get(k, 0) or 0)
            dst["n_assistant_turns"] += int(bucket.get("n_assistant_turns", 0) or 0)

    models_out: dict[str, dict[str, Any]] = {}
    total_cost = 0.0
    has_unpriced = False
    for m, bucket in agg.items():
        pricing = pricing_for_model(m)
        if pricing is None and backend_family == "codex":
            # Codex model ids may not match the resolver substrings; the
            # backend is uniformly GPT-5.5-priced.
            pricing = CODEX_GPT55_PRICING
        cost = round(estimate_cost_with(bucket, pricing), 6) if pricing else None
        if cost is None:
            has_unpriced = True
        else:
            total_cost += cost
        models_out[m] = {
            **bucket,
            "total_tokens": sum(bucket[k] for k in _MODEL_TOKEN_KEYS),
            "est_cost_usd": cost,
        }

    summed["models"] = models_out
    priced_any = any(model["est_cost_usd"] is not None for model in models_out.values())
    summed["est_cost_usd"] = round(total_cost, 6) if priced_any else None
    if has_unpriced:
        summed["has_unpriced_model"] = True
    if backend_family == "codex":
        # Preserve the fact that cache_create is structurally missing for OpenAI.
        summed["cache_create_unavailable"] = True

    return summed


def _byte_len_of_tool_result(content: Any) -> int:
    """UTF-8 byte length of a CC tool_result content payload (string or list)."""
    if isinstance(content, str):
        return len(content.encode("utf-8"))
    if isinstance(content, list):
        total = 0
        for block in content:
            if isinstance(block, dict):
                text = block.get("text", "")
                if isinstance(text, str):
                    total += len(text.encode("utf-8"))
        return total
    return 0
