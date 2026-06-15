"""Export OpenCode sessions from isolated per-run state."""

from __future__ import annotations

import json
import os
import subprocess
import tempfile
from collections.abc import Mapping
from pathlib import Path
from typing import Any, cast

from quorum.runtime_env import is_managed_host


class OpenCodeCaptureError(RuntimeError):
    """Raised when OpenCode session export cannot complete."""


def opencode_env(opencode_home: Path) -> dict[str, str]:
    return {
        "HOME": str(opencode_home),
        "XDG_CONFIG_HOME": str(opencode_home / ".config"),
        "XDG_DATA_HOME": str(opencode_home / ".local" / "share"),
        "XDG_STATE_HOME": str(opencode_home / ".local" / "state"),
        "XDG_CACHE_HOME": str(opencode_home / ".cache"),
        "TMPDIR": str(opencode_home / ".tmp"),
        "OPENCODE_CONFIG_DIR": str(opencode_home / ".config" / "opencode"),
    }


OPENCODE_ENV_ALLOWLIST = {
    "PATH",
    "TERM",
    "COLORTERM",
    "LANG",
    "LC_ALL",
    "SSL_CERT_FILE",
    "REQUESTS_CA_BUNDLE",
    "NODE_EXTRA_CA_CERTS",
    "OPENAI_API_KEY",
    "ANTHROPIC_API_KEY",
    "OPENROUTER_API_KEY",
    "GEMINI_API_KEY",
    "GOOGLE_API_KEY",
    "AWS_PROFILE",
    "AWS_REGION",
    "AWS_DEFAULT_REGION",
    "AWS_ACCESS_KEY_ID",
    "AWS_SECRET_ACCESS_KEY",
    "AWS_SESSION_TOKEN",
}
OPENCODE_PROVIDER_ENV_NAMES = {
    "OPENAI_API_KEY",
    "ANTHROPIC_API_KEY",
    "OPENROUTER_API_KEY",
    "GEMINI_API_KEY",
    "GOOGLE_API_KEY",
    "AWS_PROFILE",
    "AWS_REGION",
    "AWS_DEFAULT_REGION",
    "AWS_ACCESS_KEY_ID",
    "AWS_SECRET_ACCESS_KEY",
    "AWS_SESSION_TOKEN",
}

OPENCODE_CAPTURE_TIMEOUT_SECONDS = 30


def run_opencode_command(
    args: list[str],
    *,
    opencode_home: Path,
    launch_cwd: Path,
    timeout: float = OPENCODE_CAPTURE_TIMEOUT_SECONDS,
    env_base: Mapping[str, str] | None = None,
) -> subprocess.CompletedProcess[str]:
    """Run an opencode CLI command with stdout redirected to a file.

    The opencode binary ends every command with a bare process.exit(), which
    discards stdout that has not yet drained. Through a pipe, payloads >64KiB
    arrive truncated at the pipe-buffer boundary (still exit 0) and tiny
    replies can vanish entirely under load. A regular-file stdout drains
    synchronously, so the payload survives. stderr stays piped (always small).
    """
    with tempfile.TemporaryFile(mode="w+", encoding="utf-8") as stdout_file:
        result = subprocess.run(
            ["opencode", *args],
            cwd=launch_cwd,
            text=True,
            stdout=stdout_file,
            stderr=subprocess.PIPE,
            env=opencode_run_env(opencode_home, env_base=env_base),
            timeout=timeout,
        )
        stdout_file.seek(0)
        result.stdout = stdout_file.read()
    return result


def opencode_run_env(
    opencode_home: Path,
    env_base: Mapping[str, str] | None = None,
) -> dict[str, str]:
    source = dict(env_base) if env_base is not None else dict(os.environ)
    allowlist = set(OPENCODE_ENV_ALLOWLIST)
    source_managed = is_managed_host(source) or is_managed_host(os.environ)
    if source_managed:
        target_provider_env = {
            name.strip()
            for name in source.get("QUORUM_TARGET_ENV_KEYS", "").split(",")
            if name.strip()
        }
        allowlist -= OPENCODE_PROVIDER_ENV_NAMES
        allowlist |= target_provider_env & OPENCODE_PROVIDER_ENV_NAMES
    env = {key: value for key, value in source.items() if key in allowlist}
    env.setdefault("PATH", os.defpath)
    env.setdefault("TERM", "xterm-256color")
    env.setdefault("LANG", "C.UTF-8")
    env.update(opencode_env(opencode_home))
    return env


def _realpath(value: str | Path) -> str:
    return os.path.realpath(str(value))


def _session_decisions(
    raw_sessions: Any, launch_cwd: Path
) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    if not isinstance(raw_sessions, list):
        raise OpenCodeCaptureError("opencode session list returned non-list JSON")
    target = _realpath(launch_cwd)
    decisions: list[dict[str, Any]] = []
    matches: list[dict[str, Any]] = []
    for index, session in enumerate(raw_sessions):
        if not isinstance(session, dict):
            decisions.append({"index": index, "matched": False, "reason": "non-dict row"})
            continue
        session_row = cast(dict[str, Any], session)
        directory = session_row.get("directory")
        session_id = session_row.get("id")
        if not isinstance(directory, str) or not isinstance(session_id, str):
            decisions.append(
                {
                    "index": index,
                    "id": session_id,
                    "matched": False,
                    "reason": "missing id or directory",
                }
            )
            continue
        directory_realpath = _realpath(directory)
        matched = directory_realpath == target
        decisions.append(
            {
                "index": index,
                "id": session_id,
                "directory": directory,
                "directory_realpath": directory_realpath,
                "launch_cwd_realpath": target,
                "matched": matched,
            }
        )
        if matched:
            matches.append(session_row)
    return decisions, matches


def _list_sessions(
    *,
    opencode_home: Path,
    launch_cwd: Path,
    env_base: Mapping[str, str] | None = None,
) -> list[Any]:
    try:
        result = run_opencode_command(
            ["session", "list", "--format", "json"],
            opencode_home=opencode_home,
            launch_cwd=launch_cwd,
            env_base=env_base,
        )
    except subprocess.TimeoutExpired as e:
        raise OpenCodeCaptureError(
            f"opencode session list timed out after {OPENCODE_CAPTURE_TIMEOUT_SECONDS}s"
        ) from e
    if result.returncode != 0:
        raise OpenCodeCaptureError(
            "opencode session list failed "
            f"(exit {result.returncode}): {result.stderr.strip()[:300]}"
        )
    try:
        sessions = json.loads(result.stdout or "[]")
    except json.JSONDecodeError as e:
        raise OpenCodeCaptureError("opencode session list returned invalid JSON") from e
    if not isinstance(sessions, list):
        raise OpenCodeCaptureError("opencode session list returned non-list JSON")
    return sessions


def snapshot_opencode_sessions(
    *,
    opencode_home: Path,
    launch_cwd: Path,
    env_base: Mapping[str, str] | None = None,
) -> set[str]:
    _decisions, sessions = _session_decisions(
        _list_sessions(opencode_home=opencode_home, launch_cwd=launch_cwd, env_base=env_base),
        launch_cwd,
    )
    return {session["id"] for session in sessions}


def _session_created(session: dict[str, Any]) -> int | None:
    for key in ("created", "time_created"):
        value = session.get(key)
        if isinstance(value, int):
            return value
    return None


def _export_session(
    *,
    session_id: str,
    opencode_home: Path,
    launch_cwd: Path,
    env_base: Mapping[str, str] | None = None,
) -> tuple[dict[str, Any], str, str]:
    try:
        result = run_opencode_command(
            ["export", session_id],
            opencode_home=opencode_home,
            launch_cwd=launch_cwd,
            env_base=env_base,
        )
    except subprocess.TimeoutExpired as e:
        raise OpenCodeCaptureError(
            f"opencode export {session_id} timed out after {OPENCODE_CAPTURE_TIMEOUT_SECONDS}s"
        ) from e
    if result.returncode != 0:
        raise OpenCodeCaptureError(
            f"opencode export {session_id} failed "
            f"(exit {result.returncode}): {result.stderr.strip()[:300]}"
        )
    try:
        exported_json = json.loads(result.stdout)
    except json.JSONDecodeError as e:
        raise OpenCodeCaptureError(
            f"opencode export {session_id} returned invalid JSON "
            f"({len(result.stdout.encode('utf-8', errors='replace'))} bytes; "
            f"head: {result.stdout[:120]!r}; "
            f"stderr: {result.stderr.strip()[:300]})"
        ) from e
    exported_id = exported_json.get("info", {}).get("id")
    if exported_id != session_id:
        raise OpenCodeCaptureError(
            f"opencode export {session_id} returned session id {exported_id!r}"
        )
    return exported_json, result.stdout, result.stderr


def _exported_created(exported_json: dict[str, Any]) -> int | None:
    created = exported_json.get("info", {}).get("time", {}).get("created")
    return created if isinstance(created, int) else None


def export_opencode_sessions(
    *,
    opencode_home: Path,
    export_dir: Path,
    launch_cwd: Path,
    snapshot: set[str],
    env_base: Mapping[str, str] | None = None,
) -> tuple[Path, ...]:
    """Export OpenCode sessions for launch_cwd into export_dir."""
    export_dir.mkdir(parents=True, exist_ok=True)
    raw_sessions = _list_sessions(
        opencode_home=opencode_home,
        launch_cwd=launch_cwd,
        env_base=env_base,
    )
    decisions, sessions = _session_decisions(raw_sessions, launch_cwd)
    new_sessions = [session for session in sessions if session["id"] not in snapshot]
    export_records: list[dict[str, Any]] = []
    for session in new_sessions:
        session_id = session["id"]
        exported_json, stdout, stderr = _export_session(
            session_id=session_id,
            opencode_home=opencode_home,
            launch_cwd=launch_cwd,
            env_base=env_base,
        )
        created = _session_created(session) or _exported_created(exported_json)
        export_records.append(
            {
                "id": session_id,
                "json": exported_json,
                "stdout": stdout,
                "stderr": stderr,
                "created": created,
            }
        )
    if len(export_records) > 1 and any(record["created"] is None for record in export_records):
        raise OpenCodeCaptureError(
            "cannot order multiple new OpenCode sessions without creation times"
        )
    export_records.sort(key=lambda record: (record["created"] or 0, record["id"]))

    exported: list[Path] = []
    manifest: dict[str, Any] = {
        "raw_session_rows": raw_sessions,
        "session_decisions": decisions,
        "snapshot_ids": sorted(snapshot),
        "all_matching_ids": [session["id"] for session in sessions],
        "matched_ids": [session["id"] for session in new_sessions],
        "skipped_existing_ids": [
            session["id"] for session in sessions if session["id"] in snapshot
        ],
        "skipped_nonmatching_ids": [
            decision["id"]
            for decision in decisions
            if decision.get("id") and not decision.get("matched")
        ],
        "exports": [],
    }
    for record in export_records:
        created = record["created"] or 0
        out_path = export_dir / f"{created:016d}-{record['id']}.json"
        out_path.write_text(record["stdout"])
        manifest["exports"].append(
            {
                "id": record["id"],
                "created": created,
                "path": str(out_path),
                "stderr": record["stderr"],
            }
        )
        exported.append(out_path)

    (export_dir / "opencode-session-export-manifest.json").write_text(
        json.dumps(manifest, indent=2) + "\n"
    )
    return tuple(exported)
