"""Tests for drill.token_capture."""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from quorum.token_usage import (
    CLAUDE_OPUS_PRICING,
    CLAUDE_SONNET_PRICING,
    CODEX_GPT55_PRICING,
    PRICING_ASOF,
    capture_tokens,
    estimate_claude_cost,
    estimate_codex_cost,
    estimate_cost_with,
    parse_claude_session,
    parse_codex_rollout,
    pricing_for_model,
)

FIXTURES = Path(__file__).parent / "fixtures"


class TestParseClaudeSession:
    def test_sums_usage_across_assistant_messages(self):
        usage = parse_claude_session(FIXTURES / "cc_session.jsonl")
        assert usage is not None
        assert usage["total_input"] == 150
        assert usage["total_cache_create"] == 1000
        assert usage["total_cache_read"] == 1150
        assert usage["total_output"] == 50
        # total_tokens = input + cache_create + cache_read + output
        assert usage["total_tokens"] == 150 + 1000 + 1150 + 50
        assert usage["model"] == "claude-opus-4-7"
        # 3 assistant messages total, only 2 carry usage; we count assistant turns
        assert usage["n_assistant_turns"] == 3
        # tool_result_total_bytes: "AAAAA"(5) + "plain string output of 25 chars"(31) = 36
        assert usage["tool_result_total_bytes"] == 36

    def test_handles_missing_file(self, tmp_path: Path):
        missing = tmp_path / "nope.jsonl"
        usage = parse_claude_session(missing)
        assert usage is None

    def test_skips_messages_without_usage(self, tmp_path: Path):
        f = tmp_path / "sparse.jsonl"
        # An assistant message with no usage block must not crash and contributes 0 tokens
        f.write_text(
            json.dumps(
                {
                    "type": "assistant",
                    "message": {
                        "model": "claude-opus-4-7",
                        "role": "assistant",
                        "content": [{"type": "text", "text": "hi"}],
                    },
                }
            )
            + "\n"
        )
        usage = parse_claude_session(f)
        assert usage is not None
        assert usage["total_input"] == 0
        assert usage["total_output"] == 0
        assert usage["n_assistant_turns"] == 1
        assert usage["tool_result_total_bytes"] == 0


class TestParseCodexRollout:
    def test_uses_last_token_count_for_cumulative(self):
        usage = parse_codex_rollout(FIXTURES / "codex_rollout.jsonl")
        assert usage is not None
        # Last cumulative: input=2000 cached=900 output=120
        assert usage["total_input"] == 1100  # uncached
        assert usage["total_cache_read"] == 900
        assert usage["total_cache_create"] == 0
        assert usage["total_output"] == 120
        assert usage["total_tokens"] == 2120
        assert usage["model"] == "gpt-5.5"
        # one agent_message
        assert usage["n_assistant_turns"] == 1
        # function_call_output bytes: "file1.txt\nfile2.txt\n"(20) + "x"(1) = 21
        assert usage["tool_result_total_bytes"] == 21
        # Codex never reports cache writes - flag this so consumers know
        assert usage["cache_create_unavailable"] is True

    def test_handles_missing_file(self, tmp_path: Path):
        usage = parse_codex_rollout(tmp_path / "nope.jsonl")
        assert usage is None

    def test_handles_rollout_with_no_token_count(self, tmp_path: Path):
        f = tmp_path / "no_tokens.jsonl"
        f.write_text(
            json.dumps({"type": "session_meta", "payload": {"id": "x", "cwd": "/tmp"}}) + "\n"
        )
        usage = parse_codex_rollout(f)
        assert usage is not None
        assert usage["total_tokens"] == 0
        assert usage["total_input"] == 0


class TestCostEstimation:
    def test_claude_cost_uses_constants(self):
        # Per Opus 4.x list pricing constants
        usage = {
            "total_input": 1_000_000,
            "total_cache_create": 0,
            "total_cache_read": 0,
            "total_output": 0,
        }
        cost = estimate_claude_cost(usage)
        assert cost == pytest.approx(CLAUDE_OPUS_PRICING["input_per_m"])

    def test_claude_cost_includes_all_components(self):
        usage = {
            "total_input": 150,
            "total_cache_create": 1000,
            "total_cache_read": 1150,
            "total_output": 50,
        }
        expected = (
            150 * CLAUDE_OPUS_PRICING["input_per_m"] / 1_000_000
            + 1000 * CLAUDE_OPUS_PRICING["cache_create_per_m"] / 1_000_000
            + 1150 * CLAUDE_OPUS_PRICING["cache_read_per_m"] / 1_000_000
            + 50 * CLAUDE_OPUS_PRICING["output_per_m"] / 1_000_000
        )
        assert estimate_claude_cost(usage) == pytest.approx(expected)

    def test_codex_cost_uses_constants(self):
        usage = {"total_input": 1_000_000, "total_cache_read": 0, "total_output": 0}
        cost = estimate_codex_cost(usage)
        assert cost == pytest.approx(CODEX_GPT55_PRICING["input_per_m"])

    def test_codex_cost_uses_separate_cached_rate(self):
        usage = {"total_input": 0, "total_cache_read": 1_000_000, "total_output": 0}
        cost = estimate_codex_cost(usage)
        assert cost == pytest.approx(CODEX_GPT55_PRICING["cache_read_per_m"])


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
        assert u is not None
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
        assert u is not None
        assert u["first_ts"] == "2026-05-28T10:00:00.000Z"
        assert u["last_ts"] == "2026-05-28T10:10:00.000Z"

    def test_capture_tokens_duration_ms(self, tmp_path):
        from quorum.token_usage import capture_tokens
        p = tmp_path / "r.jsonl"
        p.write_text(
            json.dumps({"timestamp": "2026-05-28T10:00:00.000Z", "type": "session_meta",
                        "payload": {"id": "x"}}) + "\n"
            + json.dumps({"timestamp": "2026-05-28T10:00:30.000Z", "type": "event_msg",
                          "payload": {"type": "token_count",
                                      "info": {"total_token_usage": {"total_tokens": 5}}}}) + "\n"
        )
        u = capture_tokens("codex", [p])
        assert u is not None
        assert u["duration_ms"] == 30_000


class TestCaptureTokens:
    def test_claude_family_returns_full_dict(self):
        result = capture_tokens(
            backend_family="claude",
            session_log_files=[FIXTURES / "cc_session.jsonl"],
        )
        assert result is not None
        assert result["total_input"] == 150
        assert result["total_output"] == 50
        assert result["total_cache_create"] == 1000
        assert result["total_cache_read"] == 1150
        assert result["total_tokens"] == 2350
        assert result["est_cost_usd"] > 0
        assert result["model"] == "claude-opus-4-7"
        assert result["n_assistant_turns"] == 3
        assert result["tool_result_total_bytes"] == 36

    def test_codex_family_returns_full_dict(self):
        result = capture_tokens(
            backend_family="codex",
            session_log_files=[FIXTURES / "codex_rollout.jsonl"],
        )
        assert result is not None
        assert result["total_input"] == 1100
        assert result["total_cache_read"] == 900
        assert result["total_cache_create"] == 0
        assert result["total_output"] == 120
        assert result["est_cost_usd"] > 0
        assert result["cache_create_unavailable"] is True

    def test_unknown_backend_returns_none(self):
        result = capture_tokens(backend_family="other", session_log_files=[])
        assert result is None

    def test_missing_files_returns_none(self):
        result = capture_tokens(backend_family="claude", session_log_files=[])
        assert result is None

    def test_aggregates_multiple_claude_files(self, tmp_path: Path):
        # Two CC session files (e.g., main + subagent) should be summed
        f1 = tmp_path / "a.jsonl"
        f2 = tmp_path / "b.jsonl"
        for f, n_in in [(f1, 100), (f2, 200)]:
            f.write_text(
                json.dumps(
                    {
                        "type": "assistant",
                        "message": {
                            "model": "claude-opus-4-7",
                            "role": "assistant",
                            "content": [{"type": "text", "text": "x"}],
                            "usage": {
                                "input_tokens": n_in,
                                "cache_creation_input_tokens": 0,
                                "cache_read_input_tokens": 0,
                                "output_tokens": 10,
                            },
                        },
                    }
                )
                + "\n"
            )
        result = capture_tokens(backend_family="claude", session_log_files=[f1, f2])
        assert result is not None
        assert result["total_input"] == 300
        assert result["total_output"] == 20
        assert result["n_assistant_turns"] == 2


class TestPerModelPricing:
    """A single run is multi-model (main Opus + Sonnet/Haiku subagents).
    capture_tokens must price each model separately and sum (PRI-1872)."""

    def test_haiku_resolver(self):
        from quorum.token_usage import CLAUDE_HAIKU_PRICING, pricing_for_model
        assert pricing_for_model("claude-haiku-4-5-20251001") is CLAUDE_HAIKU_PRICING

    def test_parse_claude_session_splits_by_model(self, tmp_path: Path):
        from quorum.token_usage import parse_claude_session
        p = tmp_path / "s.jsonl"
        rows = [
            {"type": "assistant", "message": {"model": "claude-opus-4-7",
             "usage": {"input_tokens": 10, "output_tokens": 100}}},
            {"type": "assistant", "message": {"model": "claude-sonnet-4-6",
             "usage": {"input_tokens": 20, "output_tokens": 200}}},
            {"type": "assistant", "message": {"model": "claude-opus-4-7",
             "usage": {"input_tokens": 5, "output_tokens": 50}}},
        ]
        p.write_text("".join(json.dumps(r) + "\n" for r in rows))
        u = parse_claude_session(p)
        assert u is not None
        bm = u["by_model"]
        assert bm["claude-opus-4-7"]["total_input"] == 15
        assert bm["claude-opus-4-7"]["total_output"] == 150
        assert bm["claude-opus-4-7"]["n_assistant_turns"] == 2
        assert bm["claude-sonnet-4-6"]["total_output"] == 200

    def test_capture_tokens_prices_each_model_and_sums(self, tmp_path: Path):
        from quorum.token_usage import capture_tokens
        p = tmp_path / "s.jsonl"
        rows = [
            {"type": "assistant", "message": {"model": "claude-opus-4-7",
             "usage": {"input_tokens": 1_000_000, "output_tokens": 0}}},
            {"type": "assistant", "message": {"model": "claude-sonnet-4-6",
             "usage": {"input_tokens": 1_000_000, "output_tokens": 0}}},
        ]
        p.write_text("".join(json.dumps(r) + "\n" for r in rows))
        u = capture_tokens(backend_family="claude", session_log_files=[p])
        assert u is not None
        # Opus input 1M -> $5 ; Sonnet input 1M -> $3 ; total $8 (per-model)
        assert u["models"]["claude-opus-4-7"]["est_cost_usd"] == 5.0
        assert u["models"]["claude-sonnet-4-6"]["est_cost_usd"] == 3.0
        assert u["est_cost_usd"] == 8.0
        # NOT the single-model bug (all at Opus rate = $10)
        assert u["est_cost_usd"] != 10.0

    def test_capture_tokens_unpriced_model_flags_but_still_sums_priced(self, tmp_path: Path):
        from quorum.token_usage import capture_tokens
        p = tmp_path / "s.jsonl"
        rows = [
            {"type": "assistant", "message": {"model": "claude-opus-4-7",
             "usage": {"input_tokens": 1_000_000, "output_tokens": 0}}},
            {"type": "assistant", "message": {"model": "gemini-3-pro",
             "usage": {"input_tokens": 1_000_000, "output_tokens": 0}}},
        ]
        p.write_text("".join(json.dumps(r) + "\n" for r in rows))
        u = capture_tokens(backend_family="claude", session_log_files=[p])
        assert u is not None
        assert u["models"]["gemini-3-pro"]["est_cost_usd"] is None
        assert u["models"]["claude-opus-4-7"]["est_cost_usd"] == 5.0
        assert u["est_cost_usd"] == 5.0  # only the priced one
        assert u.get("has_unpriced_model") is True


class TestDedupByMessageId:
    """CC logs one record per content block within an assistant message,
    repeating the full usage each time. Must count each message.id once,
    keeping the last (complete) usage. PRI-1872."""

    def test_repeated_message_id_counted_once_last_wins(self, tmp_path: Path):
        from quorum.token_usage import parse_claude_session
        p = tmp_path / "s.jsonl"
        # One logical message (id=A) logged 3x: text block, then two tool_use
        # blocks. Same cache_read; output grows to the final 217.
        def _msg(output_tokens):
            return {"type": "assistant", "message": {"id": "A", "model": "claude-opus-4-7",
                    "usage": {"cache_read_input_tokens": 6146,
                              "cache_creation_input_tokens": 5076,
                              "output_tokens": output_tokens}}}
        rows = [_msg(1), _msg(217), _msg(217)]
        p.write_text("".join(json.dumps(r) + "\n" for r in rows))
        u = parse_claude_session(p)
        assert u is not None
        assert u["n_assistant_turns"] == 1                 # one API call, not 3
        assert u["total_cache_read"] == 6146               # counted once, not 18438
        assert u["total_cache_create"] == 5076             # once
        assert u["total_output"] == 217                    # last wins, not 1 or 435
