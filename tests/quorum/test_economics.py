import json

import pytest

from quorum.economics import build_run_economics


def _gauntlet_results(run_dir, *, usage_rows=None, result=None):
    d = run_dir / "gauntlet-agent" / "results" / "run-001"
    d.mkdir(parents=True)
    if result is not None:
        (d / "result.json").write_text(json.dumps(result))
    if usage_rows is not None:
        (d / "usage.jsonl").write_text("".join(json.dumps(r) + "\n" for r in usage_rows))
    return d


_SONNET_ROW = {
    "type": "obol.usage",
    "v": "2026-06-08",
    "provider": "anthropic",
    "model": "claude-sonnet-4-6",
    "service_tier": "standard",
    "usage": {
        "input_tokens": 12,
        "cache_read_input_tokens": 120,
        "cache_creation_input_tokens": 60,
        "output_tokens": 9,
    },
}
# (12*3 + 60*3.75 + 120*0.3 + 9*15)/1e6 against the fixture snapshot
_SONNET_COST = 0.000432

_RESULT = {"duration_ms": 1000, "config": {"model": "claude-sonnet-4-6"}}

_CODING_USAGE = {
    "total_input": 160,
    "total_cache_create": 1000,
    "total_cache_read": 1150,
    "total_output": 55,
    "total_tokens": 2365,
    "model": "claude-opus-4-7",
    "models": {
        "claude-opus-4-7": {
            "total_input": 150,
            "total_cache_create": 1000,
            "total_cache_read": 1150,
            "total_output": 50,
            "total_tokens": 2350,
            "provider": "anthropic",
            "est_cost_usd": 0.008825,
        },
    },
    "est_cost_usd": 0.008825,
    "unpriced_models": [],
    "approximations": [],
    "pricing_as_of": "2026-06-09",
    "duration_ms": 84000,
}


def test_full_economics(tmp_path):
    _gauntlet_results(tmp_path, usage_rows=[_SONNET_ROW], result=_RESULT)
    (tmp_path / "coding-agent-token-usage.json").write_text(json.dumps(_CODING_USAGE))

    econ = build_run_economics(tmp_path)
    assert econ is not None

    g = econ["gauntlet"]
    assert g["duration_ms"] == 1000
    assert g["model"] == "claude-sonnet-4-6"
    assert g["tokens"] == {
        "input": 12,
        "output": 9,
        "cache_create": 60,
        "cache_read": 120,
        "total": 201,
    }
    assert g["est_cost_usd"] == pytest.approx(_SONNET_COST)
    assert g["obol"]["pricing_as_of"] == "2026-06-09"

    c = econ["coding_agent"]
    assert c["duration_ms"] == 84000
    assert c["est_cost_usd"] == pytest.approx(0.008825)
    assert c["models"][0]["model"] == "claude-opus-4-7"
    assert c["has_unpriced_model"] is False
    assert c["obol"]["pricing_as_of"] == "2026-06-09"

    assert econ["total_est_cost_usd"] == pytest.approx(_SONNET_COST + 0.008825)
    assert econ["partial"] is False
    assert econ["pricing_asof"] == "2026-06-09"


def test_missing_usage_sidecar_is_partial(tmp_path):
    # Older gauntlet (no usage.jsonl): cost None, duration/model still shown.
    _gauntlet_results(tmp_path, result=_RESULT)
    (tmp_path / "coding-agent-token-usage.json").write_text(json.dumps(_CODING_USAGE))

    econ = build_run_economics(tmp_path)
    assert econ is not None

    assert econ["gauntlet"]["est_cost_usd"] is None
    assert econ["gauntlet"]["duration_ms"] == 1000
    assert econ["gauntlet"]["model"] == "claude-sonnet-4-6"
    assert econ["partial"] is True
    assert econ["total_est_cost_usd"] is None


def test_coding_block_surfaces_tool_result_bytes(tmp_path):
    _gauntlet_results(tmp_path, usage_rows=[_SONNET_ROW], result=_RESULT)
    usage = json.loads(json.dumps(_CODING_USAGE))
    usage["tool_result_total_bytes"] = 142772
    (tmp_path / "coding-agent-token-usage.json").write_text(json.dumps(usage))
    econ = build_run_economics(tmp_path)
    assert econ is not None
    assert econ["coding_agent"]["tool_result_total_bytes"] == 142772


def test_coding_block_defaults_tool_result_bytes_to_zero(tmp_path):
    _gauntlet_results(tmp_path, usage_rows=[_SONNET_ROW], result=_RESULT)
    (tmp_path / "coding-agent-token-usage.json").write_text(json.dumps(_CODING_USAGE))
    econ = build_run_economics(tmp_path)
    assert econ is not None
    assert econ["coding_agent"]["tool_result_total_bytes"] == 0


def test_missing_coding_usage_is_partial(tmp_path):
    _gauntlet_results(tmp_path, usage_rows=[_SONNET_ROW], result=_RESULT)
    econ = build_run_economics(tmp_path)
    assert econ is not None
    assert econ["coding_agent"] is None
    assert econ["partial"] is True
    assert econ["total_est_cost_usd"] is None


def test_no_sources_returns_none(tmp_path):
    assert build_run_economics(tmp_path) is None


def test_unpriced_coding_model_is_partial(tmp_path):
    _gauntlet_results(tmp_path, usage_rows=[_SONNET_ROW], result=_RESULT)
    usage = dict(_CODING_USAGE)
    usage["unpriced_models"] = ["mystery-model-9"]
    (tmp_path / "coding-agent-token-usage.json").write_text(json.dumps(usage))

    econ = build_run_economics(tmp_path)
    assert econ is not None

    assert econ["coding_agent"]["has_unpriced_model"] is True
    assert econ["partial"] is True
    assert econ["total_est_cost_usd"] is None


def test_legacy_frozen_file_renders_without_crash(tmp_path):
    # A pre-obol frozen file (no pricing_as_of/unpriced_models/approximations
    # keys): block still builds, with no obol provenance.
    legacy = {
        "total_input": 100,
        "total_cache_create": 0,
        "total_cache_read": 0,
        "total_output": 40,
        "total_tokens": 140,
        "model": "claude-opus-4-7",
        "est_cost_usd": 0.0015,
        "duration_ms": 5000,
        "models": {},
    }
    (tmp_path / "coding-agent-token-usage.json").write_text(json.dumps(legacy))

    econ = build_run_economics(tmp_path)
    assert econ is not None

    c = econ["coding_agent"]
    assert c["est_cost_usd"] == 0.0015
    assert c["obol"] is None
    assert econ["partial"] is True  # no gauntlet block


def test_mixed_unpriced_gauntlet_sidecar_gates_total(tmp_path):
    # One priced + one unpriced model in the gauntlet sidecar: the priced
    # cost still shows on the block, but the headline total must not
    # pretend completeness (never a silent undercount).
    mystery_row = {
        "type": "obol.usage",
        "v": "2026-06-08",
        "provider": "anthropic",
        "model": "mystery-model-9",
        "usage": {"input_tokens": 5_000_000, "output_tokens": 1000},
    }
    _gauntlet_results(tmp_path, usage_rows=[_SONNET_ROW, mystery_row], result=_RESULT)
    (tmp_path / "coding-agent-token-usage.json").write_text(json.dumps(_CODING_USAGE))

    econ = build_run_economics(tmp_path)

    assert econ is not None
    assert econ["gauntlet"]["has_unpriced_model"] is True
    assert econ["gauntlet"]["est_cost_usd"] == pytest.approx(_SONNET_COST)
    assert econ["total_est_cost_usd"] is None
    assert econ["partial"] is True


def test_coding_models_sorted_by_cost_desc_with_none_last(tmp_path):
    usage = json.loads(json.dumps(_CODING_USAGE))  # deep copy
    usage["models"]["claude-sonnet-4-6"] = {
        "total_input": 10,
        "total_cache_create": 0,
        "total_cache_read": 0,
        "total_output": 5,
        "total_tokens": 15,
        "provider": "anthropic",
        "est_cost_usd": 0.02,  # costlier than opus's 0.008825
    }
    usage["models"]["mystery-model-9"] = {
        "total_input": 7,
        "total_cache_create": 0,
        "total_cache_read": 0,
        "total_output": 0,
        "total_tokens": 7,
        "provider": "anthropic",
        "est_cost_usd": None,
    }
    (tmp_path / "coding-agent-token-usage.json").write_text(json.dumps(usage))

    econ = build_run_economics(tmp_path)

    assert econ is not None
    models = econ["coding_agent"]["models"]
    assert [m["model"] for m in models] == [
        "claude-sonnet-4-6",
        "claude-opus-4-7",
        "mystery-model-9",
    ]
    # per-model None cost flips has_unpriced even without unpriced_models
    assert econ["coding_agent"]["has_unpriced_model"] is True
    assert econ["partial"] is True


def test_gauntlet_block_none_when_only_coding_usage(tmp_path):
    (tmp_path / "coding-agent-token-usage.json").write_text(json.dumps(_CODING_USAGE))
    econ = build_run_economics(tmp_path)
    assert econ is not None
    assert econ["gauntlet"] is None
    assert econ["partial"] is True


def test_wrong_typed_result_config_degrades(tmp_path):
    # result.json is written by Gauntlet (external tool): config drift to a
    # list must not crash; model falls back to the sidecar's.
    _gauntlet_results(
        tmp_path,
        usage_rows=[_SONNET_ROW],
        result={"duration_ms": 1000, "config": ["not", "a", "dict"]},
    )
    (tmp_path / "coding-agent-token-usage.json").write_text(json.dumps(_CODING_USAGE))
    econ = build_run_economics(tmp_path)
    assert econ is not None
    assert econ["gauntlet"]["model"] == "claude-sonnet-4-6"  # from sidecar
    assert econ["gauntlet"]["duration_ms"] == 1000
