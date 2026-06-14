# tests/quorum/test_composer.py (replace existing content)
from quorum.checks import CheckRecord
from quorum.composer import GauntletLayer, compose


def _gl(status="pass", summary="s", reasoning="r", run_id="abc"):
    return GauntletLayer(status=status, summary=summary, reasoning=reasoning, run_id=run_id)


def _ck(name, passed, phase="post", negated=False, detail=None):
    return CheckRecord(
        check=name,
        args=[],
        negated=negated,
        passed=passed,
        detail=detail,
        phase=phase,
    )


def test_all_pass_yields_pass():
    v = compose(
        gauntlet=_gl("pass"),
        checks=[_ck("file-exists", True)],
        capture_empty=False,
        error=None,
    )
    assert v.final == "pass" and "passed" in v.final_reason.lower()


def test_check_fail_yields_fail():
    v = compose(
        gauntlet=_gl("pass"),
        checks=[_ck("file-exists", False, detail="no path")],
        capture_empty=False,
        error=None,
    )
    assert v.final == "fail"


def test_gauntlet_fail_yields_fail():
    v = compose(
        gauntlet=_gl("fail"),
        checks=[_ck("file-exists", True)],
        capture_empty=False,
        error=None,
    )
    assert v.final == "fail"


def test_gauntlet_investigate_yields_indeterminate():
    v = compose(
        gauntlet=_gl("investigate", summary="looped"),
        checks=[],
        capture_empty=False,
        error=None,
    )
    assert v.final == "indeterminate" and "investigate" in v.final_reason.lower()


def test_pre_check_failure_yields_indeterminate():
    v = compose(
        gauntlet=_gl("pass"),
        checks=[_ck("git-repo", False, phase="pre")],
        capture_empty=False,
        error=None,
    )
    assert v.final == "indeterminate"


def test_capture_empty_with_trace_check_yields_indeterminate():
    v = compose(
        gauntlet=_gl("pass"), checks=[_ck("tool-called", True)], capture_empty=True, error=None
    )
    assert v.final == "indeterminate"


def test_capture_empty_without_trace_check_passes():
    v = compose(
        gauntlet=_gl("pass"), checks=[_ck("file-exists", True)], capture_empty=True, error=None
    )
    assert v.final == "pass"


def test_error_yields_indeterminate():
    from quorum.composer import RunError

    v = compose(
        gauntlet=None, checks=[], capture_empty=False, error=RunError(stage="setup", message="boom")
    )
    assert v.final == "indeterminate"


def test_zero_checks_passes_iff_gauntlet_passed():
    assert compose(gauntlet=_gl("pass"), checks=[], capture_empty=False, error=None).final == "pass"
    assert compose(gauntlet=_gl("fail"), checks=[], capture_empty=False, error=None).final == "fail"


def test_to_dict_schema_version():
    v = compose(
        gauntlet=_gl("pass"),
        checks=[_ck("file-exists", True)],
        capture_empty=False,
        error=None,
    )
    d = v.to_dict()
    assert d["schema"] == 1
    assert d["final"] in ("pass", "fail", "indeterminate")
    assert "final_reason" in d
    assert "checks" in d and "gauntlet" in d and "error" in d


def test_finalverdict_serializes_economics():
    from quorum.composer import FinalVerdict

    econ = {
        "pricing_asof": "2026-05",
        "total_est_cost_usd": 1.5,
        "partial": False,
        "gauntlet": None,
        "coding_agent": None,
    }
    v = FinalVerdict(final="pass", economics=econ)
    d = v.to_dict()
    assert d["economics"] == econ


def test_finalverdict_economics_defaults_none():
    from quorum.composer import FinalVerdict

    assert FinalVerdict().to_dict()["economics"] is None
