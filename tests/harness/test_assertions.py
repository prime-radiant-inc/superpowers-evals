import stat
from pathlib import Path

from harness.assertions import run_assertions


def _make_executable(path: Path, body: str) -> None:
    path.write_text(body)
    path.chmod(path.stat().st_mode | stat.S_IXUSR | stat.S_IXGRP | stat.S_IXOTH)


class TestRunAssertions:
    def test_no_dir_returns_empty_pass(self, tmp_path):
        results, all_pass = run_assertions(
            assertions_dir=tmp_path / "missing",
            run_dir=tmp_path / "run",
            workdir=tmp_path / "wd",
            bin_dir=tmp_path / "bin",
        )
        assert results == []
        assert all_pass is True

    def test_runs_alphabetically_and_collects_results(self, tmp_path):
        a = tmp_path / "a"
        a.mkdir()
        for n, body in [
            ("01-first.sh", "#!/usr/bin/env bash\nexit 0\n"),
            ("02-second.sh", "#!/usr/bin/env bash\nexit 0\n"),
        ]:
            _make_executable(a / n, body)
        run_dir = tmp_path / "run"
        run_dir.mkdir()
        results, all_pass = run_assertions(
            assertions_dir=a, run_dir=run_dir,
            workdir=tmp_path / "wd", bin_dir=tmp_path / "bin",
        )
        assert [r.name for r in results] == ["01-first.sh", "02-second.sh"]
        assert all_pass is True

    def test_failing_assertion_caught_with_streams(self, tmp_path):
        a = tmp_path / "a"
        a.mkdir()
        _make_executable(a / "01-fail.sh",
            "#!/usr/bin/env bash\necho oops 1>&2\nexit 3\n")
        run_dir = tmp_path / "run"
        run_dir.mkdir()
        results, all_pass = run_assertions(
            assertions_dir=a, run_dir=run_dir,
            workdir=tmp_path / "wd", bin_dir=tmp_path / "bin",
        )
        assert all_pass is False
        assert results[0].exit_code == 3
        assert "oops" in results[0].stderr

    def test_bin_dir_on_path(self, tmp_path):
        bin_dir = tmp_path / "bin"
        bin_dir.mkdir()
        _make_executable(bin_dir / "helper", "#!/usr/bin/env bash\necho HELLO\n")
        a = tmp_path / "a"
        a.mkdir()
        _make_executable(a / "01.sh",
            "#!/usr/bin/env bash\nset -e\n[ \"$(helper)\" = HELLO ]\n")
        run_dir = tmp_path / "run"
        run_dir.mkdir()
        _, all_pass = run_assertions(
            assertions_dir=a, run_dir=run_dir,
            workdir=tmp_path / "wd", bin_dir=bin_dir,
        )
        assert all_pass is True

    def test_drill_workdir_env(self, tmp_path):
        a = tmp_path / "a"
        a.mkdir()
        wd = tmp_path / "wd"
        _make_executable(a / "01.sh",
            f'#!/usr/bin/env bash\n[ "$DRILL_WORKDIR" = "{wd}" ]\n')
        run_dir = tmp_path / "run"
        run_dir.mkdir()
        _, all_pass = run_assertions(
            assertions_dir=a, run_dir=run_dir, workdir=wd, bin_dir=tmp_path / "bin",
        )
        assert all_pass is True
