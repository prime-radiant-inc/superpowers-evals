"""Quorum-level overrides read from a scenario's story.md frontmatter.

These are quorum orchestration hints, distinct from the fields gauntlet
parses out of the story card. The `quorum_` prefix makes ownership explicit:
gauntlet ignores unknown frontmatter keys, so these are quorum-only. They are
deliberately NOT gauntlet card fields — if gauntlet honored a card-level
budget, an explicit `--max-time` on a direct `gauntlet run` would be
expected to override it, and the precedence would get confusing. Keeping
them quorum-only means quorum owns budget policy and a direct `gauntlet run
--max-time` is always authoritative on its own.
"""

from __future__ import annotations

import re
from pathlib import Path

# Frontmatter is the block between the leading `---` fences. Mirrors
# gauntlet's own lenient splitFrontmatter rather than full-yaml-parsing the
# block, so we tolerate exactly what gauntlet tolerates.
_FRONTMATTER = re.compile(r"^---\n(.*?)\n---\n", re.DOTALL)

# A gauntlet duration: bare integer (seconds) or integer with ms/s/m/h suffix.
_DURATION = re.compile(r"^\d+(ms|s|m|h)?$")

# Valid values for the quorum_tier field.
_VALID_TIERS = ("sentinel", "full", "adhoc")


class StoryMetaError(ValueError):
    """Raised when a quorum_ override in story.md frontmatter is malformed."""


def _frontmatter_field(text: str, key: str) -> str | None:
    """Return the value of a frontmatter field by key, or None if absent."""
    m = _FRONTMATTER.match(text)
    if not m:
        return None
    for line in m.group(1).splitlines():
        k, sep, v = line.partition(":")
        if sep and k.strip() == key:
            return v.strip().strip('"').strip("'")
    return None


def read_quorum_max_time(story_path: Path) -> str | None:
    """Return the `quorum_max_time` override from story.md frontmatter, or None.

    Strict-override semantics: when present, the caller uses this in place of
    the coding-agent default — it may be larger OR smaller. The value is a
    gauntlet duration string (e.g. "90m", "600s", or bare "1800" seconds).
    Raises StoryMetaError on a malformed value.
    """
    text = story_path.read_text()
    value = _frontmatter_field(text, "quorum_max_time")
    if value is None:
        return None
    if not _DURATION.match(value):
        raise StoryMetaError(
            f"{story_path}: quorum_max_time={value!r} is not a valid "
            f"duration (expected like 90m, 600s, or bare seconds 1800)"
        )
    return value


def read_quorum_tier(story_path: Path) -> str:
    """Return the `quorum_tier` from story.md frontmatter, defaulting to "full".

    Valid values: "sentinel", "full", "adhoc". Raises StoryMetaError on an
    unknown value.
    """
    text = story_path.read_text()
    value = _frontmatter_field(text, "quorum_tier")
    if value is None:
        return "full"
    if value not in _VALID_TIERS:
        raise StoryMetaError(
            f"{story_path}: quorum_tier={value!r} is not valid "
            f"(expected one of: {', '.join(_VALID_TIERS)})"
        )
    return value


def read_story_status(story_path: Path) -> str:
    """Return the `status` from story.md frontmatter, defaulting to "ready"."""
    text = story_path.read_text()
    value = _frontmatter_field(text, "status")
    return value if value is not None else "ready"
