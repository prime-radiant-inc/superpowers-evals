from pathlib import Path

import pytest

import quorum.agy_creds


@pytest.fixture(autouse=True)
def _isolate_agy_credential(tmp_path, monkeypatch):
    """Never let the test suite read or touch the real ~/.gemini/oauth_creds.json.

    Points _CRED_PATH at a non-existent tmp file by default, so backup_credential()
    returns None for any test that does not deliberately create and re-point it
    (test_agy_creds.py re-points it within each test, which still wins).
    """
    monkeypatch.setattr(quorum.agy_creds, "_CRED_PATH", tmp_path / "oauth_creds.json")


_PRICING_FIXTURE = Path(__file__).parent / "fixtures" / "pricing"


@pytest.fixture(autouse=True)
def _obol_pricing_fixture(monkeypatch):
    """Pin obol to the committed test-only snapshot.

    OBOL_PRICING_DIR wins absolutely in obol's resolution, so tests are
    hermetic against the embedded snapshot's version and any local
    `obol refresh` state. Tests that want the default resolution
    (test_obol_smoke.py) delenv it explicitly.
    """
    monkeypatch.setenv("OBOL_PRICING_DIR", str(_PRICING_FIXTURE))


@pytest.fixture(autouse=True)
def _fast_capture_retry(monkeypatch):
    """Keep the empty-capture retry (PRI-2081) instant in tests.

    The retry logic still runs (attempts unchanged), but the inter-attempt
    delay is zeroed so the runner tests that exercise genuinely-empty
    captures don't pay (attempts - 1) * 2s of wall clock each.
    """
    import quorum.runner

    monkeypatch.setattr(quorum.runner, "CAPTURE_RETRY_DELAY_S", 0.0)
