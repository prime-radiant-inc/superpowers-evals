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
