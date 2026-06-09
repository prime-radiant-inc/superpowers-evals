import json

from quorum.timing import session_logs_duration_ms


def _write(path, rows):
    path.write_text("\n".join(json.dumps(r) for r in rows) + "\n")


def test_iso_timestamps_span(tmp_path):
    f = tmp_path / "s.jsonl"
    _write(
        f,
        [
            {"type": "user", "timestamp": "2026-06-09T00:00:00.000Z"},
            {"type": "assistant", "timestamp": "2026-06-09T00:01:24.000Z"},
        ],
    )
    assert session_logs_duration_ms([f]) == 84_000


def test_numeric_time_span(tmp_path):
    # Kimi usage.record rows carry epoch-ms `time`.
    f = tmp_path / "wire.jsonl"
    _write(
        f,
        [
            {"type": "usage.record", "time": 1_800_000_000_000},
            {"type": "usage.record", "time": 1_800_000_042_000},
        ],
    )
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
        "not json\n"
        '{"timestamp": "2026-06-09T00:00:00Z"}\n'
        '{"timestamp": 42}\n'
        '{"timestamp": "2026-06-09T00:00:10Z"}\n'
    )
    assert session_logs_duration_ms([f]) == 10_000


def test_missing_file_ignored(tmp_path):
    assert session_logs_duration_ms([tmp_path / "nope.jsonl"]) is None
