import stat
from pathlib import Path

import pytest

from harness.setup_step import PreflightError, SetupError, run_preflight, run_setup


def _make_executable(path: Path, body: str) -> None:
    path.write_text(body)
    path.chmod(path.stat().st_mode | stat.S_IXUSR | stat.S_IXGRP | stat.S_IXOTH)


class TestRunSetup:
    def test_no_setup_is_fine(self, tmp_path):
        scenario_dir = tmp_path / "scenario"
        scenario_dir.mkdir()
        workdir = tmp_path / "wd"
        workdir.mkdir()
        run_setup(scenario_dir, workdir)  # should not raise

    def test_zero_exit_succeeds_and_workdir_mutated(self, tmp_path):
        scenario_dir = tmp_path / "scenario"
        scenario_dir.mkdir()
        workdir = tmp_path / "wd"
        workdir.mkdir()
        _make_executable(
            scenario_dir / "setup.sh",
            "#!/usr/bin/env bash\nset -e\necho hello > marker\n",
        )
        run_setup(scenario_dir, workdir)
        assert (workdir / "marker").read_text().strip() == "hello"

    def test_nonzero_exit_raises_with_streams(self, tmp_path):
        scenario_dir = tmp_path / "scenario"
        scenario_dir.mkdir()
        workdir = tmp_path / "wd"
        workdir.mkdir()
        _make_executable(
            scenario_dir / "setup.sh",
            "#!/usr/bin/env bash\necho boom 1>&2\nexit 7\n",
        )
        with pytest.raises(SetupError) as exc:
            run_setup(scenario_dir, workdir)
        assert "exit 7" in str(exc.value)
        assert "boom" in str(exc.value)

    def test_drill_workdir_env_set(self, tmp_path):
        scenario_dir = tmp_path / "scenario"
        scenario_dir.mkdir()
        workdir = tmp_path / "wd"
        workdir.mkdir()
        marker_path = tmp_path / "captured_workdir"
        _make_executable(
            scenario_dir / "setup.sh",
            f'#!/usr/bin/env bash\necho "$HARNESS_WORKDIR" > {marker_path}\n',
        )
        run_setup(scenario_dir, workdir)
        assert marker_path.read_text().strip() == str(workdir)

    def test_env_extra_propagates_to_subprocess(self, tmp_path):
        scenario_dir = tmp_path / "scenario"
        scenario_dir.mkdir()
        workdir = tmp_path / "wd"
        workdir.mkdir()
        marker_path = tmp_path / "captured_extra"
        _make_executable(
            scenario_dir / "setup.sh",
            f'#!/usr/bin/env bash\necho "$HARNESS_REPO_ROOT" > {marker_path}\n',
        )
        run_setup(scenario_dir, workdir, env_extra={"HARNESS_REPO_ROOT": "/fake/root"})
        assert marker_path.read_text().strip() == "/fake/root"


class TestRunPreflight:
    def test_no_preflight_is_fine(self, tmp_path):
        scenario_dir = tmp_path / "scenario"
        scenario_dir.mkdir()
        workdir = tmp_path / "wd"
        workdir.mkdir()
        run_preflight(scenario_dir, workdir)  # should not raise

    def test_zero_exit_succeeds(self, tmp_path):
        scenario_dir = tmp_path / "scenario"
        scenario_dir.mkdir()
        workdir = tmp_path / "wd"
        workdir.mkdir()
        _make_executable(
            scenario_dir / "preflight.sh",
            '#!/usr/bin/env bash\nset -e\ntest -d "$HARNESS_WORKDIR"\n',
        )
        run_preflight(scenario_dir, workdir)  # invariant holds → no raise

    def test_failed_invariant_raises_preflight_error(self, tmp_path):
        scenario_dir = tmp_path / "scenario"
        scenario_dir.mkdir()
        workdir = tmp_path / "wd"
        workdir.mkdir()
        _make_executable(
            scenario_dir / "preflight.sh",
            '#!/usr/bin/env bash\necho "missing the plan" 1>&2\nexit 1\n',
        )
        with pytest.raises(PreflightError) as exc:
            run_preflight(scenario_dir, workdir)
        assert "preflight.sh" in str(exc.value)
        assert "missing the plan" in str(exc.value)
