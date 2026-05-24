# tests/harness/test_git_tools.py
import json
import subprocess
from pathlib import Path

BIN = Path("harness/bin").resolve()

def _repo(tmp_path: Path) -> Path:
    p = tmp_path / "r"
    p.mkdir()
    subprocess.run(["git", "init", "-q", "-b", "main"], cwd=p, check=True)
    subprocess.run(["git", "-c", "user.email=t@t", "-c", "user.name=t",
                    "commit", "--allow-empty", "-q", "-m", "i"], cwd=p, check=True)
    return p

def _run(tool: str, *args: str, cwd: Path, sink: Path) -> int:
    return subprocess.run([str(BIN/tool), *args], cwd=cwd,
        env={"PATH": f"{BIN}:/usr/bin:/bin", "HARNESS_RECORD_SINK": str(sink)},
        capture_output=True, text=True).returncode

def _r(sink): return json.loads(sink.read_text().splitlines()[-1])

def test_git_repo_pass(tmp_path):
    r = _repo(tmp_path)
    sink = tmp_path/"s"
    assert _run("git-repo", cwd=r, sink=sink) == 0 and _r(sink)["passed"]

def test_git_repo_fail_outside_repo(tmp_path):
    sink = tmp_path/"s"
    assert _run("git-repo", cwd=tmp_path, sink=sink) != 0 and not _r(sink)["passed"]

def test_git_branch_match(tmp_path):
    r = _repo(tmp_path)
    sink = tmp_path/"s"
    assert _run("git-branch", "main", cwd=r, sink=sink) == 0 and _r(sink)["passed"]

def test_git_branch_mismatch(tmp_path):
    r = _repo(tmp_path)
    sink = tmp_path/"s"
    assert _run("git-branch", "feature", cwd=r, sink=sink) != 0 and not _r(sink)["passed"]

def test_git_clean(tmp_path):
    r = _repo(tmp_path)
    sink = tmp_path/"s"
    assert _run("git-clean", cwd=r, sink=sink) == 0

def test_git_count_commits(tmp_path):
    r = _repo(tmp_path)
    sink = tmp_path/"s"
    assert _run("git-count", "commits", "eq", "1", cwd=r, sink=sink) == 0

def test_git_count_worktrees(tmp_path):
    r = _repo(tmp_path)
    sink = tmp_path/"s"
    assert _run("git-count", "worktrees", "eq", "1", cwd=r, sink=sink) == 0
