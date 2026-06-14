# tests/quorum/test_story_meta.py
import pytest

from quorum.story_meta import (
    StoryMetaError,
    read_quorum_max_time,
    read_quorum_tier,
    read_story_status,
)


def _story(tmp_path, body: str):
    p = tmp_path / "story.md"
    p.write_text(body)
    return p


FM = "---\nid: x\ntitle: y\ntags: sdd\n{extra}---\n\nBody text.\n"


def test_no_frontmatter_returns_none(tmp_path):
    p = _story(tmp_path, "No frontmatter here, just body.\n")
    assert read_quorum_max_time(p) is None


def test_frontmatter_without_key_returns_none(tmp_path):
    p = _story(tmp_path, FM.format(extra=""))
    assert read_quorum_max_time(p) is None


def test_minutes_value(tmp_path):
    p = _story(tmp_path, FM.format(extra="quorum_max_time: 90m\n"))
    assert read_quorum_max_time(p) == "90m"


def test_seconds_value(tmp_path):
    p = _story(tmp_path, FM.format(extra="quorum_max_time: 600s\n"))
    assert read_quorum_max_time(p) == "600s"


def test_bare_seconds_value(tmp_path):
    p = _story(tmp_path, FM.format(extra="quorum_max_time: 1800\n"))
    assert read_quorum_max_time(p) == "1800"


def test_quoted_value_is_stripped(tmp_path):
    p = _story(tmp_path, FM.format(extra='quorum_max_time: "45m"\n'))
    assert read_quorum_max_time(p) == "45m"


def test_malformed_value_raises(tmp_path):
    p = _story(tmp_path, FM.format(extra="quorum_max_time: ninety\n"))
    with pytest.raises(StoryMetaError):
        read_quorum_max_time(p)


# --- read_quorum_tier + read_story_status ---


def _simple_story(tmp_path, frontmatter):
    p = tmp_path / "story.md"
    p.write_text(f"---\n{frontmatter}\n---\n\nbody\n")
    return p


def test_tier_defaults_to_full(tmp_path):
    assert read_quorum_tier(_simple_story(tmp_path, "id: x")) == "full"


def test_tier_read_and_validated(tmp_path):
    assert read_quorum_tier(_simple_story(tmp_path, "quorum_tier: sentinel")) == "sentinel"
    assert read_quorum_tier(_simple_story(tmp_path, "quorum_tier: adhoc")) == "adhoc"


def test_tier_invalid_raises(tmp_path):
    with pytest.raises(StoryMetaError):
        read_quorum_tier(_simple_story(tmp_path, "quorum_tier: turbo"))


def test_status_defaults_to_ready_and_reads(tmp_path):
    assert read_story_status(_simple_story(tmp_path, "id: x")) == "ready"
    assert read_story_status(_simple_story(tmp_path, "status: draft")) == "draft"


def test_no_frontmatter_is_defaults(tmp_path):
    p = tmp_path / "story.md"
    p.write_text("no frontmatter here\n")
    assert read_quorum_tier(p) == "full"
    assert read_story_status(p) == "ready"
