"""Regression tests: worktree sibling paths land under workdir.parent.

Under the new quorum model, the workdir is <run-dir>/coding-agent-workdir/.
Sibling directories (worktrees, codex-home) must be computed relative to
workdir.parent so they all land under the same run dir, not escaped to some
hardcoded location.
"""

from pathlib import Path

from setup_helpers.worktree import _sibling_path


def test_sibling_lands_under_workdir_parent(tmp_path: Path) -> None:
    wd = tmp_path / "rundir" / "coding-agent-workdir"
    wd.mkdir(parents=True)
    sib = _sibling_path(wd, "existing-worktree")
    assert sib.parent == wd.parent
    assert sib.name == "coding-agent-workdir-existing-worktree"


def test_sibling_codex_home_lands_under_workdir_parent(tmp_path: Path) -> None:
    wd = tmp_path / "rundir" / "coding-agent-workdir"
    wd.mkdir(parents=True)
    sib = _sibling_path(wd, "codex-home")
    assert sib.parent == wd.parent
    assert sib.name == "coding-agent-workdir-codex-home"


def test_sibling_suffix_is_appended_with_dash(tmp_path: Path) -> None:
    wd = tmp_path / "rundir" / "coding-agent-workdir"
    wd.mkdir(parents=True)
    sib = _sibling_path(wd, "some-suffix")
    assert sib == wd.parent / "coding-agent-workdir-some-suffix"


def test_sibling_not_child_of_workdir(tmp_path: Path) -> None:
    wd = tmp_path / "rundir" / "coding-agent-workdir"
    wd.mkdir(parents=True)
    sib = _sibling_path(wd, "existing-worktree")
    # The sibling must NOT be inside the workdir itself.
    assert not str(sib).startswith(str(wd) + "/")
