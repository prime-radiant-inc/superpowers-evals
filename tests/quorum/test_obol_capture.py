import json
from pathlib import Path

import pytest

from quorum.obol_capture import estimate_session_logs, estimate_usage_sidecar

FIXTURES = Path(__file__).parent / "fixtures"

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

        assert usage is not None
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
        assert usage is not None
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
        assert usage is not None
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
        assert usage is not None
        assert usage["unpriced_models"] == ["mystery-model-9"]
        assert usage["est_cost_usd"] is None  # all-unpriced: no silent $0
        assert usage["total_input"] == 100   # tokens still reported

    def test_mixed_priced_and_unpriced(self, tmp_path):
        # One priced + one unpriced model: priced cost survives at top level,
        # the unpriced model is flagged per-model and in unpriced_models.
        f = tmp_path / "s.jsonl"
        f.write_text(_claude_row("claude-opus-4-7", "m1", 100, 0, 0, 40)
                     + _claude_row("mystery-model-9", "m2", 50, 0, 0, 5))
        usage = estimate_session_logs("claude", [f])
        assert usage is not None
        assert usage["unpriced_models"] == ["mystery-model-9"]
        assert usage["est_cost_usd"] == pytest.approx(0.0015)  # opus only
        assert usage["models"]["mystery-model-9"]["est_cost_usd"] is None
        assert usage["models"]["claude-opus-4-7"]["est_cost_usd"] == pytest.approx(0.0015)

    def test_same_model_across_files_accumulates(self, tmp_path):
        # The accumulate-into-existing-bucket path: same model in two files.
        a, b = tmp_path / "a.jsonl", tmp_path / "b.jsonl"
        a.write_text(_claude_row("claude-opus-4-7", "m1", 100, 0, 0, 20))
        b.write_text(_claude_row("claude-opus-4-7", "m2", 50, 0, 0, 30))
        usage = estimate_session_logs("claude", [a, b])
        assert usage is not None
        assert usage["total_input"] == 150
        assert usage["total_output"] == 50
        assert usage["models"]["claude-opus-4-7"]["total_input"] == 150
        # (150*5 + 50*25)/1e6
        assert usage["est_cost_usd"] == pytest.approx(0.002)

    def test_garbage_sibling_file_contributes_nothing(self, tmp_path):
        # Line-oriented dialects skip unparseable content (obol returns an
        # empty estimate, same resilience the pre-obol parser had), so a
        # garbage sibling file leaves the good file's usage intact. The
        # ObolError -> None guard covers structural failures instead
        # (pricing tables missing, sidecar schema rejection).
        good, bad = tmp_path / "good.jsonl", tmp_path / "bad.jsonl"
        good.write_text(_claude_row("claude-opus-4-7", "m1", 100, 0, 0, 20))
        bad.write_text("\x00\x01 not jsonl at all")
        usage = estimate_session_logs("claude", [good, bad])
        assert usage is not None
        assert usage["total_input"] == 100
        # (100*5 + 20*25)/1e6
        assert usage["est_cost_usd"] == pytest.approx(0.001)


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
        assert usage is not None
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
