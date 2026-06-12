import subprocess
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "scripts" / "run-with-log"


def test_run_with_log_records_exit_status_when_invoked_from_zsh(tmp_path):
    if subprocess.run(["which", "zsh"], capture_output=True).returncode != 0:
        pytest.skip("zsh is not installed")

    log = tmp_path / "command.log"

    result = subprocess.run(
        [
            "zsh",
            "-fc",
            '"$@"',
            "zsh",
            str(SCRIPT),
            "--log",
            str(log),
            "--",
            "/bin/sh",
            "-c",
            "echo hello; exit 7",
        ],
        cwd=ROOT,
        text=True,
        capture_output=True,
        check=False,
    )

    output = result.stdout + result.stderr
    assert result.returncode == 7
    assert "read-only variable: status" not in output

    log_text = log.read_text()
    assert "hello" in result.stdout
    assert "hello" in log_text
    assert "START_UTC:" in log_text
    assert "END_UTC:" in log_text
    assert "EXIT_STATUS: 7" in log_text
    assert "read-only variable: status" not in log_text
