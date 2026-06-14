import json
import subprocess

import pytest

from quorum.opencode_capture import (
    OpenCodeCaptureError,
    export_opencode_sessions,
    opencode_env,
    opencode_run_env,
    snapshot_opencode_sessions,
)


def test_opencode_env_isolates_home_and_xdg(tmp_path):
    home = tmp_path / "home"

    env = opencode_env(home)

    assert env == {
        "HOME": str(home),
        "XDG_CONFIG_HOME": str(home / ".config"),
        "XDG_DATA_HOME": str(home / ".local" / "share"),
        "XDG_STATE_HOME": str(home / ".local" / "state"),
        "XDG_CACHE_HOME": str(home / ".cache"),
        "TMPDIR": str(home / ".tmp"),
        "OPENCODE_CONFIG_DIR": str(home / ".config" / "opencode"),
    }


def test_opencode_run_env_scrubs_harness_paths_and_preserves_provider_env(tmp_path, monkeypatch):
    home = tmp_path / "home"
    monkeypatch.setenv("SUPERPOWERS_ROOT", "/real/superpowers")
    monkeypatch.setenv("QUORUM_AGENT_CWD", "/real/workdir")
    monkeypatch.setenv("OPENCODE_CONFIG_DIR", "/real/opencode")
    monkeypatch.setenv("OPENAI_API_KEY", "sk-test")
    monkeypatch.setenv("PATH", "/bin")

    env = opencode_run_env(home)

    assert env["OPENAI_API_KEY"] == "sk-test"
    assert env["PATH"] == "/bin"
    assert env["OPENCODE_CONFIG_DIR"] == str(home / ".config" / "opencode")
    assert "SUPERPOWERS_ROOT" not in env
    assert "QUORUM_AGENT_CWD" not in env


def _completed(cmd, kwargs, stdout, stderr="", returncode=0):
    """Mimic run_opencode_command's seam: stdout goes to the file, not the pipe."""
    kwargs["stdout"].write(stdout)
    return subprocess.CompletedProcess(cmd, returncode, "", stderr)


def test_snapshot_opencode_sessions_filters_by_launch_cwd(tmp_path, monkeypatch):
    home = tmp_path / "home"
    launch_cwd = tmp_path / "project"
    launch_cwd.mkdir()

    def fake_run(cmd, **kwargs):
        assert cmd == ["opencode", "session", "list", "--format", "json"]
        assert kwargs["cwd"] == launch_cwd
        return _completed(
            cmd,
            kwargs,
            json.dumps(
                [
                    {"id": "ses_old", "directory": str(launch_cwd)},
                    {"id": "ses_other", "directory": str(tmp_path / "other")},
                ]
            ),
        )

    monkeypatch.setattr("quorum.opencode_capture.subprocess.run", fake_run)

    assert snapshot_opencode_sessions(opencode_home=home, launch_cwd=launch_cwd) == {"ses_old"}


def test_export_opencode_sessions_exports_only_new_matching_sessions_and_manifest(
    tmp_path, monkeypatch
):
    home = tmp_path / "home"
    export_dir = home / ".quorum" / "session-exports"
    launch_real = tmp_path / "real-project"
    launch_real.mkdir()
    launch_link = tmp_path / "linked-project"
    launch_link.symlink_to(launch_real, target_is_directory=True)
    calls = []

    def fake_run(cmd, **kwargs):
        calls.append((cmd, kwargs))
        assert kwargs["cwd"] == launch_link
        assert kwargs["text"] is True
        assert kwargs["stdout"] is not subprocess.PIPE
        assert kwargs["stderr"] is subprocess.PIPE
        assert kwargs["env"]["HOME"] == str(home)
        assert "SUPERPOWERS_ROOT" not in kwargs["env"]
        if cmd == ["opencode", "session", "list", "--format", "json"]:
            return _completed(
                cmd,
                kwargs,
                json.dumps(
                    [
                        {
                            "id": "ses_old",
                            "directory": str(launch_real.resolve()),
                            "created": 100,
                        },
                        {
                            "id": "ses_new",
                            "directory": str(launch_real.resolve()),
                            "created": 200,
                        },
                        {"id": "ses_other", "directory": str(tmp_path / "other")},
                    ]
                ),
            )
        if cmd == ["opencode", "export", "ses_new"]:
            return _completed(
                cmd,
                kwargs,
                json.dumps(
                    {
                        "info": {
                            "id": "ses_new",
                            "time": {"created": 200},
                        },
                        "messages": [],
                    }
                ),
                "Exporting session: ses_new\n",
            )
        raise AssertionError(f"unexpected command: {cmd}")

    monkeypatch.setattr("quorum.opencode_capture.subprocess.run", fake_run)

    exported = export_opencode_sessions(
        opencode_home=home,
        export_dir=export_dir,
        launch_cwd=launch_link,
        snapshot={"ses_old"},
    )

    assert exported == (export_dir / "0000000000000200-ses_new.json",)
    assert json.loads(exported[0].read_text())["info"]["id"] == "ses_new"
    manifest = json.loads((export_dir / "opencode-session-export-manifest.json").read_text())
    assert manifest["raw_session_rows"][0]["id"] == "ses_old"
    assert manifest["snapshot_ids"] == ["ses_old"]
    assert manifest["matched_ids"] == ["ses_new"]
    assert manifest["skipped_existing_ids"] == ["ses_old"]
    assert manifest["skipped_nonmatching_ids"] == ["ses_other"]
    assert manifest["session_decisions"][0]["matched"] is True
    assert manifest["session_decisions"][2]["matched"] is False
    assert manifest["exports"][0]["stderr"] == "Exporting session: ses_new\n"
    assert [call[0] for call in calls] == [
        ["opencode", "session", "list", "--format", "json"],
        ["opencode", "export", "ses_new"],
    ]


def test_export_opencode_sessions_returns_empty_when_no_matching_session(tmp_path, monkeypatch):
    home = tmp_path / "home"
    launch_cwd = tmp_path / "project"
    launch_cwd.mkdir()

    def fake_run(cmd, **kwargs):
        assert cmd == ["opencode", "session", "list", "--format", "json"]
        return _completed(
            cmd,
            kwargs,
            json.dumps([{"id": "ses_other", "directory": str(tmp_path / "other")}]),
        )

    monkeypatch.setattr("quorum.opencode_capture.subprocess.run", fake_run)

    assert (
        export_opencode_sessions(
            opencode_home=home,
            export_dir=home / ".quorum" / "session-exports",
            launch_cwd=launch_cwd,
            snapshot=set(),
        )
        == ()
    )


def test_export_opencode_sessions_orders_by_exported_created_when_list_lacks_created(
    tmp_path, monkeypatch
):
    home = tmp_path / "home"
    export_dir = home / ".quorum" / "session-exports"
    launch_cwd = tmp_path / "project"
    launch_cwd.mkdir()

    def fake_run(cmd, **kwargs):
        if cmd == ["opencode", "session", "list", "--format", "json"]:
            return _completed(
                cmd,
                kwargs,
                json.dumps(
                    [
                        {"id": "ses_late", "directory": str(launch_cwd)},
                        {"id": "ses_early", "directory": str(launch_cwd)},
                    ]
                ),
            )
        session_id = cmd[-1]
        created = {"ses_early": 10, "ses_late": 20}[session_id]
        return _completed(
            cmd,
            kwargs,
            json.dumps({"info": {"id": session_id, "time": {"created": created}}, "messages": []}),
        )

    monkeypatch.setattr("quorum.opencode_capture.subprocess.run", fake_run)

    exported = export_opencode_sessions(
        opencode_home=home,
        export_dir=export_dir,
        launch_cwd=launch_cwd,
        snapshot=set(),
    )

    assert exported == (
        export_dir / "0000000000000010-ses_early.json",
        export_dir / "0000000000000020-ses_late.json",
    )


def test_export_opencode_sessions_raises_on_list_failure(tmp_path, monkeypatch):
    def fake_run(cmd, **kwargs):
        return subprocess.CompletedProcess(cmd, 1, "", "bad auth")

    monkeypatch.setattr("quorum.opencode_capture.subprocess.run", fake_run)

    with pytest.raises(OpenCodeCaptureError, match="session list"):
        export_opencode_sessions(
            opencode_home=tmp_path / "home",
            export_dir=tmp_path / "exports",
            launch_cwd=tmp_path,
            snapshot=set(),
        )


def test_export_opencode_sessions_raises_on_list_timeout(tmp_path, monkeypatch):
    def fake_run(cmd, **kwargs):
        raise subprocess.TimeoutExpired(cmd, timeout=30)

    monkeypatch.setattr("quorum.opencode_capture.subprocess.run", fake_run)

    with pytest.raises(OpenCodeCaptureError, match="session list timed out"):
        export_opencode_sessions(
            opencode_home=tmp_path / "home",
            export_dir=tmp_path / "exports",
            launch_cwd=tmp_path,
            snapshot=set(),
        )


def test_export_opencode_sessions_raises_on_export_failure(tmp_path, monkeypatch):
    launch_cwd = tmp_path / "project"
    launch_cwd.mkdir()

    def fake_run(cmd, **kwargs):
        if cmd == ["opencode", "session", "list", "--format", "json"]:
            return _completed(
                cmd,
                kwargs,
                json.dumps([{"id": "ses_match", "directory": str(launch_cwd), "created": 10}]),
            )
        return _completed(cmd, kwargs, "", "export failed", returncode=2)

    monkeypatch.setattr("quorum.opencode_capture.subprocess.run", fake_run)

    with pytest.raises(OpenCodeCaptureError, match="export ses_match"):
        export_opencode_sessions(
            opencode_home=tmp_path / "home",
            export_dir=tmp_path / "exports",
            launch_cwd=launch_cwd,
            snapshot=set(),
        )


def test_export_opencode_sessions_raises_on_export_timeout(tmp_path, monkeypatch):
    launch_cwd = tmp_path / "project"
    launch_cwd.mkdir()

    def fake_run(cmd, **kwargs):
        if cmd == ["opencode", "session", "list", "--format", "json"]:
            return _completed(
                cmd,
                kwargs,
                json.dumps([{"id": "ses_match", "directory": str(launch_cwd), "created": 10}]),
            )
        raise subprocess.TimeoutExpired(cmd, timeout=30)

    monkeypatch.setattr("quorum.opencode_capture.subprocess.run", fake_run)

    with pytest.raises(OpenCodeCaptureError, match="export ses_match timed out"):
        export_opencode_sessions(
            opencode_home=tmp_path / "home",
            export_dir=tmp_path / "exports",
            launch_cwd=launch_cwd,
            snapshot=set(),
        )


def test_export_opencode_sessions_raises_when_multiple_new_sessions_lack_ordering(
    tmp_path, monkeypatch
):
    launch_cwd = tmp_path / "project"
    launch_cwd.mkdir()

    def fake_run(cmd, **kwargs):
        if cmd == ["opencode", "session", "list", "--format", "json"]:
            return _completed(
                cmd,
                kwargs,
                json.dumps(
                    [
                        {"id": "ses_a", "directory": str(launch_cwd)},
                        {"id": "ses_b", "directory": str(launch_cwd)},
                    ]
                ),
            )
        session_id = cmd[-1]
        return _completed(cmd, kwargs, json.dumps({"info": {"id": session_id}, "messages": []}))

    monkeypatch.setattr("quorum.opencode_capture.subprocess.run", fake_run)

    with pytest.raises(OpenCodeCaptureError, match="cannot order"):
        export_opencode_sessions(
            opencode_home=tmp_path / "home",
            export_dir=tmp_path / "exports",
            launch_cwd=launch_cwd,
            snapshot=set(),
        )


# The opencode CLI (bun-compiled) ends every command with a bare
# process.exit(), which discards stdout that has not yet drained. Through a
# pipe, exports >64KiB arrive truncated at the pipe-buffer boundary with exit
# code 0; tiny replies can vanish entirely. These tests run the real capture
# code against a fake `opencode` binary that honours that contract: full
# payload when stdout is a regular file, first 64KiB when stdout is a pipe.
_FAKE_OPENCODE = """#!/usr/bin/env python3
import json, os, stat, sys

args = sys.argv[1:]


def stdout_is_pipe():
    return stat.S_ISFIFO(os.fstat(1).st_mode)


if args[:4] == ["session", "list", "--format", "json"]:
    sys.stdout.write(json.dumps([{"id": "ses_big", "directory": os.getcwd(), "created": 7}]))
elif args and args[0] == "export":
    if os.path.exists(os.path.join(os.path.dirname(os.path.abspath(sys.argv[0])), "garbage-mode")):
        sys.stdout.write("definitely not json")
        sys.stderr.write("provider exploded\\n")
        sys.exit(0)
    payload = json.dumps(
        {"info": {"id": args[1], "time": {"created": 7}}, "messages": [{"filler": "x" * 200000}]}
    ).encode()
    os.write(1, payload[:65536] if stdout_is_pipe() else payload)
    sys.stderr.write("Exporting session: " + args[1] + "\\n")
"""


def _install_fake_opencode(tmp_path, monkeypatch, *, garbage_mode=False):
    import os

    bin_dir = tmp_path / "fake-bin"
    bin_dir.mkdir(exist_ok=True)
    fake = bin_dir / "opencode"
    fake.write_text(_FAKE_OPENCODE)
    fake.chmod(0o755)
    if garbage_mode:
        (bin_dir / "garbage-mode").touch()
    monkeypatch.setenv("PATH", f"{bin_dir}:{os.environ['PATH']}")


def test_export_opencode_sessions_completes_despite_pipe_truncation(tmp_path, monkeypatch):
    _install_fake_opencode(tmp_path, monkeypatch)
    home = tmp_path / "home"
    launch_cwd = tmp_path / "project"
    launch_cwd.mkdir()

    exported = export_opencode_sessions(
        opencode_home=home,
        export_dir=home / ".quorum" / "session-exports",
        launch_cwd=launch_cwd,
        snapshot=set(),
    )

    data = json.loads(exported[0].read_text())
    assert data["info"]["id"] == "ses_big"
    assert len(data["messages"][0]["filler"]) == 200000


def test_export_invalid_json_error_carries_stdout_and_stderr_evidence(tmp_path, monkeypatch):
    _install_fake_opencode(tmp_path, monkeypatch, garbage_mode=True)
    home = tmp_path / "home"
    launch_cwd = tmp_path / "project"
    launch_cwd.mkdir()

    with pytest.raises(OpenCodeCaptureError) as excinfo:
        export_opencode_sessions(
            opencode_home=home,
            export_dir=home / ".quorum" / "session-exports",
            launch_cwd=launch_cwd,
            snapshot=set(),
        )

    message = str(excinfo.value)
    assert "invalid JSON" in message
    assert "definitely not json" in message
    assert "provider exploded" in message
    assert "19 bytes" in message
