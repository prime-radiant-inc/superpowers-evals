# tests/quorum/test_assert_checkout_clean.py
import json
import subprocess
from pathlib import Path

from setup_helpers.base import record_head

BIN = Path("bin").resolve()


def _repo(tmp_path: Path) -> Path:
    p = tmp_path / "r"
    p.mkdir()
    subprocess.run(["git", "init", "-q", "-b", "main"], cwd=p, check=True)
    subprocess.run(
        [
            "git",
            "-c",
            "user.email=t@t",
            "-c",
            "user.name=t",
            "commit",
            "--allow-empty",
            "-q",
            "-m",
            "i",
        ],
        cwd=p,
        check=True,
    )
    return p


def _run(*args: str, cwd: Path, sink: Path) -> int:
    return subprocess.run(
        [str(BIN / "assert-checkout-clean"), *args],
        cwd=cwd,
        env={"PATH": f"{BIN}:/usr/bin:/bin", "QUORUM_RECORD_SINK": str(sink)},
        capture_output=True,
        text=True,
    ).returncode


def _r(sink):
    return json.loads(sink.read_text().splitlines()[-1])


def test_pass_on_clean_repo(tmp_path):
    r = _repo(tmp_path)
    sink = tmp_path / "s"
    assert _run(str(r), cwd=tmp_path, sink=sink) == 0 and _r(sink)["passed"]


def test_fail_on_untracked_file(tmp_path):
    r = _repo(tmp_path)
    (r / "leak.txt").write_text("leak\n")
    sink = tmp_path / "s"
    assert _run(str(r), cwd=tmp_path, sink=sink) != 0 and not _r(sink)["passed"]


def test_fail_on_modified_tracked_file(tmp_path):
    r = _repo(tmp_path)
    (r / "a.txt").write_text("v1\n")
    subprocess.run(["git", "add", "a.txt"], cwd=r, check=True)
    subprocess.run(
        ["git", "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "a"],
        cwd=r,
        check=True,
    )
    (r / "a.txt").write_text("v2\n")
    sink = tmp_path / "s"
    assert _run(str(r), cwd=tmp_path, sink=sink) != 0 and not _r(sink)["passed"]


def test_fail_on_staged_uncommitted_file(tmp_path):
    r = _repo(tmp_path)
    (r / "staged.txt").write_text("s\n")
    subprocess.run(["git", "add", "staged.txt"], cwd=r, check=True)
    sink = tmp_path / "s"
    assert _run(str(r), cwd=tmp_path, sink=sink) != 0 and not _r(sink)["passed"]


def test_launch_cwd_sentinel_is_ignored(tmp_path):
    r = _repo(tmp_path)
    (r / ".quorum-launch-cwd").write_text("/elsewhere\n")
    sink = tmp_path / "s"
    assert _run(str(r), cwd=tmp_path, sink=sink) == 0 and _r(sink)["passed"]


def test_pass_when_head_matches_recorded(tmp_path):
    r = _repo(tmp_path)
    record_head(r)
    sink = tmp_path / "s"
    assert _run(str(r), cwd=tmp_path, sink=sink) == 0 and _r(sink)["passed"]


def test_fail_when_head_moved_after_recording(tmp_path):
    r = _repo(tmp_path)
    record_head(r)
    subprocess.run(
        [
            "git",
            "-c",
            "user.email=t@t",
            "-c",
            "user.name=t",
            "commit",
            "--allow-empty",
            "-q",
            "-m",
            "moved",
        ],
        cwd=r,
        check=True,
    )
    sink = tmp_path / "s"
    assert _run(str(r), cwd=tmp_path, sink=sink) != 0 and not _r(sink)["passed"]


def test_fail_on_non_repo_path(tmp_path):
    sink = tmp_path / "s"
    assert _run(str(tmp_path), cwd=tmp_path, sink=sink) != 0 and not _r(sink)["passed"]


def test_fail_closed_when_git_status_errors(tmp_path):
    r = _repo(tmp_path)
    (r / "a.txt").write_text("v1\n")
    subprocess.run(["git", "add", "a.txt"], cwd=r, check=True)
    subprocess.run(
        ["git", "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "a"],
        cwd=r,
        check=True,
    )
    # Corrupt the index: rev-parse --is-inside-work-tree still succeeds,
    # but `git status --porcelain` fails. The tool must fail closed.
    (r / ".git" / "index").write_bytes(b"corrupt")
    sink = tmp_path / "s"
    assert _run(str(r), cwd=tmp_path, sink=sink) != 0 and not _r(sink)["passed"]


def test_pass_on_main_checkout_with_linked_worktree(tmp_path):
    r = _repo(tmp_path)
    record_head(r)
    wt = tmp_path / "wt"
    subprocess.run(["git", "worktree", "add", "-q", str(wt), "-b", "feature"], cwd=r, check=True)
    sink = tmp_path / "s"
    assert _run(str(r), cwd=tmp_path, sink=sink) == 0 and _r(sink)["passed"]
