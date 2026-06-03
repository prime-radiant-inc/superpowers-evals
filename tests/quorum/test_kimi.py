import json
import os
import stat
import subprocess
import tempfile

import pytest

from quorum.kimi import (
    KimiConfigError,
    build_kimi_subprocess_env,
    effective_kimi_model_env,
    write_effective_kimi_config,
    write_kimi_runtime_env_file,
)


def test_effective_env_allows_only_api_key_and_model_name():
    with pytest.raises(KimiConfigError, match="KIMI_MODEL_BASE_URL"):
        effective_kimi_model_env(
            {
                "KIMI_MODEL_API_KEY": "fake-key",
                "KIMI_MODEL_NAME": "kimi-custom",
                "KIMI_MODEL_BASE_URL": "https://wrong.example",
            }
        )


def test_effective_env_supplies_defaults():
    env = effective_kimi_model_env({"KIMI_MODEL_API_KEY": "fake-key"})

    assert env["KIMI_MODEL_API_KEY"] == "fake-key"
    assert env["KIMI_MODEL_NAME"] == "kimi-for-coding"
    assert env["KIMI_MODEL_PROVIDER_TYPE"] == "kimi"
    assert env["KIMI_MODEL_BASE_URL"] == "https://api.kimi.com/coding/v1"
    assert env["KIMI_DISABLE_TELEMETRY"] == "1"
    assert env["KIMI_CODE_BACKGROUND_KEEP_ALIVE_ON_EXIT"] == "false"


def test_sanitized_env_drops_host_state(monkeypatch, tmp_path):
    monkeypatch.setenv("PATH", "/usr/bin:/bin")
    monkeypatch.setenv("HOME", "/real/home")
    monkeypatch.setenv("XDG_CONFIG_HOME", "/real/xdg")
    monkeypatch.setenv("KIMI_CODE_HOME", "/real/kimi")
    monkeypatch.setenv("MOONSHOT_API_KEY", "do-not-copy")

    kimi_home = tmp_path / "kimi-home"
    env = build_kimi_subprocess_env(
        base_env=os.environ,
        kimi_home=kimi_home,
        cwd=tmp_path / "cwd",
        kimi_model_env={"KIMI_MODEL_API_KEY": "fake-key", "KIMI_MODEL_NAME": "kimi"},
    )

    assert env["PATH"] == "/usr/bin:/bin"
    assert env["HOME"] == str(kimi_home / "home")
    assert env["KIMI_CODE_HOME"] == str(kimi_home)
    assert env["KIMI_CODE_CACHE_DIR"] == str(kimi_home / "cache")
    assert env["XDG_CONFIG_HOME"] == str(kimi_home / "xdg-config")
    assert env["XDG_CACHE_HOME"] == str(kimi_home / "xdg-cache")
    assert env["XDG_DATA_HOME"] == str(kimi_home / "xdg-data")
    assert "MOONSHOT_API_KEY" not in env


def test_runtime_env_file_is_0600_outside_run_dir_and_sourceable(tmp_path):
    run_dir = tmp_path / "results" / "run"
    run_dir.mkdir(parents=True)
    env_file = write_kimi_runtime_env_file(
        {
            "KIMI_MODEL_API_KEY": "fake key with spaces",
            "KIMI_MODEL_NAME": "kimi-for-coding",
        },
        run_dir=run_dir,
    )

    assert not str(env_file).startswith(str(run_dir))
    assert stat.S_IMODE(env_file.stat().st_mode) == 0o600

    script = 'set -a; . "$1"; set +a; printf \'%s\\n\' "$KIMI_MODEL_API_KEY"'
    result = subprocess.run(
        ["bash", "-c", script, "bash", str(env_file)],
        text=True,
        capture_output=True,
        check=True,
    )
    assert result.stdout.strip() == "fake key with spaces"


def test_runtime_env_file_avoids_process_temp_dir_inside_run_dir(monkeypatch, tmp_path):
    run_dir = tmp_path / "results" / "run"
    run_dir.mkdir(parents=True)
    monkeypatch.setenv("TMPDIR", str(run_dir))
    monkeypatch.setattr(tempfile, "tempdir", str(run_dir))

    env_file = write_kimi_runtime_env_file(
        {"KIMI_MODEL_API_KEY": "fake-key"},
        run_dir=run_dir,
    )

    assert not env_file.resolve().is_relative_to(run_dir.resolve())


def test_runtime_env_file_avoids_process_temp_dir_inside_results_root(monkeypatch, tmp_path):
    run_dir = tmp_path / "results" / "run"
    run_dir.mkdir(parents=True)
    monkeypatch.setenv("TMPDIR", str(run_dir.parent))
    monkeypatch.setattr(tempfile, "tempdir", str(run_dir.parent))

    env_file = write_kimi_runtime_env_file(
        {"KIMI_MODEL_API_KEY": "fake-key"},
        run_dir=run_dir,
    )

    assert not env_file.resolve().is_relative_to(run_dir.resolve())
    assert not env_file.resolve().is_relative_to(run_dir.parent.resolve())


def test_effective_config_summary_redacts_api_key(tmp_path):
    path = write_effective_kimi_config(
        tmp_path,
        {
            "KIMI_MODEL_API_KEY": "fake-key",
            "KIMI_MODEL_NAME": "kimi-for-coding",
            "KIMI_MODEL_PROVIDER_TYPE": "kimi",
        },
        kimi_binary="/usr/bin/kimi",
        kimi_version="kimi 0.6.0",
    )

    data = json.loads(path.read_text())
    assert data["kimi_binary"] == "/usr/bin/kimi"
    assert data["kimi_version"] == "kimi 0.6.0"
    assert data["model_env"]["KIMI_MODEL_API_KEY"] == "<present>"
    assert "fake-key" not in path.read_text()


def test_effective_config_summary_omits_non_kimi_runtime_env(tmp_path):
    path = write_effective_kimi_config(
        tmp_path,
        {
            "KIMI_MODEL_API_KEY": "fake-key",
            "KIMI_MODEL_NAME": "kimi-for-coding",
            "KIMI_DISABLE_TELEMETRY": "1",
            "HTTPS_PROXY": "secret",
            "PATH": "/secret/bin",
            "HOME": "/secret/home",
        },
        kimi_binary="/usr/bin/kimi",
        kimi_version="kimi 0.6.0",
    )

    text = path.read_text()
    data = json.loads(text)

    assert data["model_env"]["KIMI_MODEL_API_KEY"] == "<present>"
    assert data["model_env"]["KIMI_MODEL_NAME"] == "kimi-for-coding"
    assert data["model_env"]["KIMI_DISABLE_TELEMETRY"] == "1"
    assert "HTTPS_PROXY" not in data["model_env"]
    assert "PATH" not in data["model_env"]
    assert "HOME" not in data["model_env"]
    assert "secret" not in text
    assert "/secret/bin" not in text
    assert "/secret/home" not in text
