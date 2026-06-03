import json
import os
import stat
import subprocess
import tempfile
from pathlib import Path

import pytest

from quorum.kimi import (
    KimiConfigError,
    build_kimi_subprocess_env,
    effective_kimi_model_env,
    install_kimi_superpowers_plugin,
    kimi_logs_have_superpowers_session_start,
    kimi_preflight_sentinel_payload,
    kimi_stream_json_reply_ok,
    run_kimi_auth_preflight,
    sanitize_kimi_diagnostic,
    validate_kimi_preflight_sentinel,
    validate_superpowers_kimi_root,
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
    assert "PWD" not in env
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


def test_kimi_preflight_sentinel_payload_round_trips_validation(tmp_path):
    env = effective_kimi_model_env({"KIMI_MODEL_API_KEY": "fake-key"})
    path = tmp_path / "sentinel.json"
    path.write_text(
        json.dumps(
            kimi_preflight_sentinel_payload(
                kimi_binary="/usr/local/bin/kimi-custom",
                kimi_model_env=env,
            )
        )
        + "\n"
    )

    validate_kimi_preflight_sentinel(
        path,
        kimi_binary="/usr/local/bin/kimi-custom",
        kimi_model_env=env,
    )


def test_kimi_preflight_sentinel_rejects_malformed_json(tmp_path):
    env = effective_kimi_model_env({"KIMI_MODEL_API_KEY": "fake-key"})
    path = tmp_path / "sentinel.json"
    path.write_text("{not-json")

    with pytest.raises(KimiConfigError, match="valid JSON"):
        validate_kimi_preflight_sentinel(
            path,
            kimi_binary="/usr/local/bin/kimi",
            kimi_model_env=env,
        )


def test_kimi_preflight_sentinel_rejects_model_mismatch(tmp_path):
    env = effective_kimi_model_env({"KIMI_MODEL_API_KEY": "fake-key"})
    path = tmp_path / "sentinel.json"
    payload = kimi_preflight_sentinel_payload(
        kimi_binary="/usr/local/bin/kimi",
        kimi_model_env=env,
    )
    payload["model"] = "other-model"
    path.write_text(json.dumps(payload) + "\n")

    with pytest.raises(KimiConfigError, match="model"):
        validate_kimi_preflight_sentinel(
            path,
            kimi_binary="/usr/local/bin/kimi",
            kimi_model_env=env,
        )


def test_kimi_preflight_sentinel_rejects_binary_mismatch(tmp_path):
    env = effective_kimi_model_env({"KIMI_MODEL_API_KEY": "fake-key"})
    path = tmp_path / "sentinel.json"
    path.write_text(
        json.dumps(
            kimi_preflight_sentinel_payload(
                kimi_binary="/usr/local/bin/kimi-a",
                kimi_model_env=env,
            )
        )
        + "\n"
    )

    with pytest.raises(KimiConfigError, match="binary"):
        validate_kimi_preflight_sentinel(
            path,
            kimi_binary="/usr/local/bin/kimi-b",
            kimi_model_env=env,
        )


def test_sanitize_kimi_diagnostic_redacts_sensitive_values():
    text = sanitize_kimi_diagnostic(
        "preflight failed for fake-secret and token-value but not abc",
        env={
            "KIMI_MODEL_API_KEY": "fake-secret",
            "OTHER_TOKEN": "token-value",
            "TINY_KEY": "abc",
        },
    )

    assert "fake-secret" not in text
    assert "token-value" not in text
    assert "<redacted>" in text
    assert "abc" in text


def _superpowers_root(tmp_path: Path) -> Path:
    root = tmp_path / "superpowers"
    (root / ".kimi-plugin").mkdir(parents=True)
    (root / "skills" / "using-superpowers").mkdir(parents=True)
    (root / "skills" / "brainstorming").mkdir(parents=True)
    (root / ".kimi-plugin" / "plugin.json").write_text(
        json.dumps(
            {
                "name": "superpowers",
                "skills": "./skills/",
                "sessionStart": {"skill": "using-superpowers"},
                "skillInstructions": {"tools": {"Bash": "shell"}},
            }
        )
    )
    (root / "skills" / "using-superpowers" / "SKILL.md").write_text("skill")
    (root / "skills" / "brainstorming" / "SKILL.md").write_text("skill")
    return root


def test_validate_superpowers_kimi_root_accepts_manifest(tmp_path):
    root = _superpowers_root(tmp_path)
    assert validate_superpowers_kimi_root(root) == root.resolve()


def test_validate_superpowers_kimi_root_rejects_wrong_session_start(tmp_path):
    root = _superpowers_root(tmp_path)
    manifest = json.loads((root / ".kimi-plugin" / "plugin.json").read_text())
    manifest["sessionStart"]["skill"] = "other"
    (root / ".kimi-plugin" / "plugin.json").write_text(json.dumps(manifest))

    with pytest.raises(KimiConfigError, match="sessionStart.skill"):
        validate_superpowers_kimi_root(root)


def test_install_kimi_superpowers_plugin_writes_local_path_metadata(tmp_path):
    root = _superpowers_root(tmp_path)
    kimi_home = tmp_path / "kimi-home"

    installed_path = install_kimi_superpowers_plugin(kimi_home, root)

    installed = json.loads(installed_path.read_text())
    assert installed["version"] == 1
    assert len(installed["plugins"]) == 1
    plugin = installed["plugins"][0]
    assert plugin["id"] == "superpowers"
    assert plugin["enabled"] is True
    assert plugin["source"] == "local-path"
    assert Path(plugin["root"]).resolve() == root.resolve()
    assert not (kimi_home / "plugins" / "managed" / "superpowers").exists()


def test_kimi_stream_json_reply_ok_accepts_assistant_ok():
    stdout = "\n".join(
        [
            json.dumps({"type": "system", "message": "ignored"}),
            json.dumps({"type": "assistant", "content": "OK."}),
        ]
    )
    assert kimi_stream_json_reply_ok(stdout)


def test_kimi_stream_json_reply_ok_accepts_role_assistant_string_content():
    stdout = json.dumps({"role": "assistant", "content": "OK."})
    assert kimi_stream_json_reply_ok(stdout)


def test_kimi_stream_json_reply_ok_accepts_role_assistant_array_content():
    stdout = json.dumps(
        {"role": "assistant", "content": [{"type": "text", "text": "O"}, {"text": "K!"}]}
    )
    assert kimi_stream_json_reply_ok(stdout)


def test_kimi_stream_json_reply_ok_ignores_tool_rows():
    stdout = json.dumps({"type": "message", "role": "tool", "content": "OK"})
    assert not kimi_stream_json_reply_ok(stdout)


def test_kimi_stream_json_reply_ok_rejects_verbose_reply():
    stdout = json.dumps({"type": "assistant", "content": "OK, I will do that"})
    assert not kimi_stream_json_reply_ok(stdout)


def test_kimi_logs_have_superpowers_session_start(tmp_path):
    wire = tmp_path / "wire.jsonl"
    wire.write_text(
        json.dumps(
            {
                "type": "context.append_loop_event",
                "event": {
                    "type": "plugin_session_start",
                    "plugin": "superpowers",
                    "skill": "using-superpowers",
                },
            }
        )
        + "\n"
    )

    assert kimi_logs_have_superpowers_session_start([wire])


def test_kimi_logs_reject_missing_superpowers_session_start(tmp_path):
    wire = tmp_path / "wire.jsonl"
    wire.write_text(json.dumps({"type": "context.append_loop_event", "event": {}}) + "\n")

    assert not kimi_logs_have_superpowers_session_start([wire])


def test_run_kimi_auth_preflight_uses_throwaway_home_and_checks_logs(tmp_path, monkeypatch):
    calls = []

    def fake_run(cmd, **kwargs):
        calls.append((cmd, kwargs))
        kimi_home = Path(kwargs["env"]["KIMI_CODE_HOME"])
        cwd = Path(kwargs["cwd"])
        session = kimi_home / "sessions" / "wd" / "session" / "agents" / "main"
        session.mkdir(parents=True)
        (session / "wire.jsonl").write_text("{}\n")
        (kimi_home / "session_index.jsonl").write_text(
            json.dumps({"sessionDir": str(session.parent.parent), "workDir": str(cwd)}) + "\n"
        )
        return subprocess.CompletedProcess(
            cmd,
            0,
            json.dumps({"type": "assistant", "content": "OK"}) + "\n",
            "",
        )

    monkeypatch.setattr("quorum.kimi.subprocess.run", fake_run)
    run_kimi_auth_preflight(
        kimi_binary="kimi",
        kimi_model_env={"KIMI_MODEL_API_KEY": "fake", "KIMI_MODEL_NAME": "kimi"},
        base_env={"PATH": "/usr/bin:/bin"},
    )

    cmd, kwargs = calls[0]
    assert cmd == ["kimi", "-p", "Reply with EXACTLY OK.", "--output-format=stream-json"]
    assert Path(kwargs["env"]["KIMI_CODE_HOME"]).name.startswith("kimi-home")
    assert kwargs["env"]["KIMI_MODEL_API_KEY"] == "fake"


def test_run_kimi_auth_preflight_requires_wire_log_under_matching_session_dir(monkeypatch):
    def fake_run(cmd, **kwargs):
        kimi_home = Path(kwargs["env"]["KIMI_CODE_HOME"])
        cwd = Path(kwargs["cwd"])
        matched_session = kimi_home / "sessions" / "wd" / "session"
        unmatched_main = kimi_home / "sessions" / "other" / "session" / "agents" / "main"
        unmatched_main.mkdir(parents=True)
        (unmatched_main / "wire.jsonl").write_text("{}\n")
        (kimi_home / "session_index.jsonl").write_text(
            json.dumps({"sessionDir": str(matched_session), "workDir": str(cwd)}) + "\n"
        )
        return subprocess.CompletedProcess(
            cmd,
            0,
            json.dumps({"role": "assistant", "content": "OK"}) + "\n",
            "",
        )

    monkeypatch.setattr("quorum.kimi.subprocess.run", fake_run)

    with pytest.raises(KimiConfigError, match="matching sessionDir produced no wire.jsonl"):
        run_kimi_auth_preflight(
            kimi_binary="kimi",
            kimi_model_env={"KIMI_MODEL_API_KEY": "fake", "KIMI_MODEL_NAME": "kimi"},
            base_env={"PATH": "/usr/bin:/bin"},
        )


def test_run_kimi_auth_preflight_rejects_matching_session_dir_outside_kimi_home(
    tmp_path, monkeypatch
):
    external_session = tmp_path / "external-session"

    def fake_run(cmd, **kwargs):
        kimi_home = Path(kwargs["env"]["KIMI_CODE_HOME"])
        cwd = Path(kwargs["cwd"])
        kimi_home.mkdir(parents=True)
        external_main = external_session / "agents" / "main"
        external_main.mkdir(parents=True)
        (external_main / "wire.jsonl").write_text("{}\n")
        (kimi_home / "session_index.jsonl").write_text(
            json.dumps({"sessionDir": str(external_session), "workDir": str(cwd)}) + "\n"
        )
        return subprocess.CompletedProcess(
            cmd,
            0,
            json.dumps({"role": "assistant", "content": "OK"}) + "\n",
            "",
        )

    monkeypatch.setattr("quorum.kimi.subprocess.run", fake_run)

    with pytest.raises(KimiConfigError, match="sessionDir.*outside.*Kimi home/sessions"):
        run_kimi_auth_preflight(
            kimi_binary="kimi",
            kimi_model_env={"KIMI_MODEL_API_KEY": "fake", "KIMI_MODEL_NAME": "kimi"},
            base_env={"PATH": "/usr/bin:/bin"},
        )
