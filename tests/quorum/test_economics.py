import json
from pathlib import Path

from quorum.economics import build_run_economics


def _gauntlet_result(run_dir: Path, *, model="claude-sonnet-4-6", duration_ms=120000):
    rid = "run-x"
    d = run_dir / "gauntlet-agent" / "results" / rid
    d.mkdir(parents=True)
    (d / "result.json").write_text(json.dumps({
        "runId": rid, "duration_ms": duration_ms,
        "usage": {"inputTokens": 100, "outputTokens": 200,
                  "cacheCreationInputTokens": 0, "cacheReadInputTokens": 1000},
        "config": {"model": model},
    }))


def _coding_usage(run_dir: Path, **over):
    payload = {"total_input": 50, "total_cache_create": 0, "total_cache_read": 0,
               "total_output": 80, "total_tokens": 130, "model": "gpt-5.5",
               "est_cost_usd": 1.23, "duration_ms": 90000}
    payload.update(over)
    (run_dir / "coding-agent-token-usage.json").write_text(json.dumps(payload))


def test_both_agents_present(tmp_path):
    _gauntlet_result(tmp_path)
    _coding_usage(tmp_path)
    econ = build_run_economics(tmp_path)
    assert econ is not None
    assert econ["gauntlet"]["duration_ms"] == 120000
    assert econ["gauntlet"]["est_cost_usd"] is not None
    assert econ["coding_agent"]["duration_ms"] == 90000
    assert econ["coding_agent"]["est_cost_usd"] == 1.23
    assert econ["total_est_cost_usd"] == round(
        econ["gauntlet"]["est_cost_usd"] + 1.23, 6)
    assert econ["partial"] is False
    assert econ["pricing_asof"]


def test_missing_coding_usage_is_partial(tmp_path):
    _gauntlet_result(tmp_path)
    econ = build_run_economics(tmp_path)
    assert econ is not None
    assert econ["coding_agent"] is None
    assert econ["partial"] is True
    assert econ["total_est_cost_usd"] is None


def test_missing_gauntlet_result_is_partial(tmp_path):
    _coding_usage(tmp_path)
    econ = build_run_economics(tmp_path)
    assert econ is not None
    assert econ["gauntlet"] is None
    assert econ["partial"] is True


def test_unpriced_gauntlet_model_yields_null_cost(tmp_path):
    _gauntlet_result(tmp_path, model="gemini-3-pro")
    _coding_usage(tmp_path)
    econ = build_run_economics(tmp_path)
    assert econ is not None
    assert econ["gauntlet"]["est_cost_usd"] is None
    assert econ["gauntlet"]["tokens"]["total"] > 0
    # total is null because one side is unpriced
    assert econ["total_est_cost_usd"] is None
    assert econ["partial"] is True


def test_unpriced_coding_agent_yields_null_total_cost(tmp_path):
    _gauntlet_result(tmp_path)
    _coding_usage(
        tmp_path,
        model="kimi-for-coding",
        est_cost_usd=None,
        has_unpriced_model=True,
    )
    econ = build_run_economics(tmp_path)
    assert econ is not None
    assert econ["gauntlet"]["est_cost_usd"] is not None
    assert econ["coding_agent"]["est_cost_usd"] is None
    assert econ["coding_agent"]["tokens"]["total"] == 130
    assert econ["total_est_cost_usd"] is None
    assert econ["partial"] is True


def test_mixed_unpriced_coding_models_keep_total_partial(tmp_path):
    _gauntlet_result(tmp_path)
    _coding_usage(
        tmp_path,
        total_input=2_000_000,
        total_output=0,
        total_tokens=2_000_000,
        model="claude-opus-4-7",
        est_cost_usd=5.0,
        has_unpriced_model=True,
        models={
            "claude-opus-4-7": {
                "total_input": 1_000_000,
                "total_cache_create": 0,
                "total_cache_read": 0,
                "total_output": 0,
                "total_tokens": 1_000_000,
                "n_assistant_turns": 1,
                "est_cost_usd": 5.0,
            },
            "kimi-for-coding": {
                "total_input": 1_000_000,
                "total_cache_create": 0,
                "total_cache_read": 0,
                "total_output": 0,
                "total_tokens": 1_000_000,
                "n_assistant_turns": 1,
                "est_cost_usd": None,
            },
        },
    )
    econ = build_run_economics(tmp_path)
    assert econ is not None
    assert econ["coding_agent"]["est_cost_usd"] == 5.0
    assert econ["coding_agent"]["has_unpriced_model"] is True
    assert econ["total_est_cost_usd"] is None
    assert econ["partial"] is True


def test_no_sources_returns_none(tmp_path):
    assert build_run_economics(tmp_path) is None


def test_coding_block_carries_per_model_breakdown(tmp_path):
    _gauntlet_result(tmp_path)
    (tmp_path / "coding-agent-token-usage.json").write_text(json.dumps({
        "total_input": 30, "total_cache_create": 0, "total_cache_read": 0,
        "total_output": 130, "total_tokens": 160, "model": "claude-opus-4-7",
        "est_cost_usd": 31.59, "duration_ms": 90000,
        "models": {
            "claude-opus-4-7": {"total_input": 10, "total_cache_create": 0,
                "total_cache_read": 0, "total_output": 100, "total_tokens": 110,
                "n_assistant_turns": 1, "est_cost_usd": 25.09},
            "claude-sonnet-4-6": {"total_input": 20, "total_cache_create": 0,
                "total_cache_read": 0, "total_output": 30, "total_tokens": 50,
                "n_assistant_turns": 1, "est_cost_usd": 6.50},
        },
    }))
    econ = build_run_economics(tmp_path)
    assert econ is not None
    models = econ["coding_agent"]["models"]
    assert len(models) == 2
    # sorted by cost desc → opus first
    assert models[0]["model"] == "claude-opus-4-7"
    assert models[0]["est_cost_usd"] == 25.09
    assert models[1]["model"] == "claude-sonnet-4-6"
    assert econ["coding_agent"]["est_cost_usd"] == 31.59


def _claude_session(run_dir):
    d = run_dir / "coding-agent-config" / "projects" / "proj"
    d.mkdir(parents=True)
    rows = [
        {"type": "assistant", "timestamp": "2026-05-28T10:00:00.000Z",
         "message": {"model": "claude-opus-4-7",
                     "usage": {"input_tokens": 1_000_000, "output_tokens": 0}}},
        {"type": "assistant", "timestamp": "2026-05-28T10:01:00.000Z",
         "message": {"model": "claude-sonnet-4-6",
                     "usage": {"input_tokens": 1_000_000, "output_tokens": 0}}},
    ]
    (d / "s.jsonl").write_text("".join(json.dumps(r) + "\n" for r in rows))


def test_backfill_injects_economics_into_existing_verdict(tmp_path):
    from quorum.economics import backfill_run_economics
    _gauntlet_result(tmp_path)
    _claude_session(tmp_path)
    # Existing verdict.json WITHOUT economics (pre-feature run).
    (tmp_path / "verdict.json").write_text(json.dumps(
        {"schema": 1, "final": "pass", "final_reason": "ok",
         "gauntlet": {"status": "pass"}, "checks": [], "error": None}))

    status = backfill_run_economics(tmp_path)
    assert status == "backfilled"

    verdict = json.loads((tmp_path / "verdict.json").read_text())
    econ = verdict["economics"]
    # Coding cost is per-model: Opus 1M input ($5) + Sonnet 1M input ($3) = $8
    assert econ["coding_agent"]["est_cost_usd"] == 8.0
    models = {m["model"]: m["est_cost_usd"] for m in econ["coding_agent"]["models"]}
    assert models["claude-opus-4-7"] == 5.0
    assert models["claude-sonnet-4-6"] == 3.0
    # Regenerated sidecar carries the per-model breakdown.
    usage = json.loads((tmp_path / "coding-agent-token-usage.json").read_text())
    assert "models" in usage
    # Original verdict fields preserved.
    assert verdict["final"] == "pass"


def test_backfill_skips_when_no_verdict(tmp_path):
    from quorum.economics import backfill_run_economics
    _claude_session(tmp_path)
    assert backfill_run_economics(tmp_path) == "skipped (no verdict.json)"
