"""Smoke tests for the obol binding itself — pricing resolution both ways."""

import pytest

import obol


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
