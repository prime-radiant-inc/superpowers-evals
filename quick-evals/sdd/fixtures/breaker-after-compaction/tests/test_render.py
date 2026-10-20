from datetime import datetime, timezone

from src.digest import Digest, render


def test_render_has_subject_then_items():
    at = datetime(2026, 10, 15, 14, 0, tzinfo=timezone.utc)
    d = Digest("ana", "Europe/Lisbon", [{"at": at, "title": "Build passed"}], at)
    out = render(d).splitlines()
    assert out[0].startswith("Your digest for")
    assert out[1] == ""
    assert out[2] == "15:00  Build passed"
