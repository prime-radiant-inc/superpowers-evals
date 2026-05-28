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
    _gauntlet_result(tmp_path); _coding_usage(tmp_path)
    econ = build_run_economics(tmp_path)
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
    assert econ["coding_agent"] is None
    assert econ["partial"] is True
    assert econ["total_est_cost_usd"] is None


def test_missing_gauntlet_result_is_partial(tmp_path):
    _coding_usage(tmp_path)
    econ = build_run_economics(tmp_path)
    assert econ["gauntlet"] is None
    assert econ["partial"] is True


def test_unpriced_gauntlet_model_yields_null_cost(tmp_path):
    _gauntlet_result(tmp_path, model="gemini-3-pro"); _coding_usage(tmp_path)
    econ = build_run_economics(tmp_path)
    assert econ["gauntlet"]["est_cost_usd"] is None
    assert econ["gauntlet"]["tokens"]["total"] > 0
    # total is null because one side is unpriced
    assert econ["total_est_cost_usd"] is None
    assert econ["partial"] is True


def test_no_sources_returns_none(tmp_path):
    assert build_run_economics(tmp_path) is None
