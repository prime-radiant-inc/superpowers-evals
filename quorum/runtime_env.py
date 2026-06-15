"""Managed-host runtime environment helpers."""

from __future__ import annotations

import hmac
import os
import re
import shlex
from collections.abc import Mapping
from dataclasses import dataclass
from pathlib import Path

from quorum.managed_state import ManagedPaths

RAW_COMMAND_DISABLED_MESSAGE = (
    "raw live eval commands are disabled on the managed Quorum host; "
    "use quorum smoke, quorum column, or quorum batch"
)
MANAGED_WORKER_TOKEN_PATH = Path("/opt/quorum/state/worker-token")

_ENV_NAME_RE = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")
_TARGET_RE = re.compile(r"^[A-Za-z0-9_.-]+$")
_BASE_ENV_ALLOWLIST = (
    "PATH",
    "HOME",
    "TMPDIR",
    "LANG",
    "LC_ALL",
    "QUORUM_MANAGED_HOST",
    "QUORUM_MANAGED_WORKER",
    "QUORUM_TARGET_PROFILE_ROOT",
    "SUPERPOWERS_ROOT",
)
_RUNTIME_ENV_ALLOWLIST = {
    "PATH",
    "HOME",
    "TMPDIR",
    "LANG",
    "LC_ALL",
    "SUPERPOWERS_ROOT",
}
_CONTROLLER_ENV_KEYS = {
    "QUORUM_ARTIFACT_ROOT",
    "QUORUM_STATE_ROOT",
    "QUORUM_TARGET",
    "QUORUM_TARGET_ENV_KEYS",
    "QUORUM_MANAGED_WORKER_TOKEN",
}


@dataclass(frozen=True)
class TargetProfile:
    target: str
    path: Path | None
    env: Mapping[str, str]


class TargetProfileError(RuntimeError):
    """Raised when a managed target profile is missing or malformed."""


def is_managed_host(env: Mapping[str, str]) -> bool:
    return env.get("QUORUM_MANAGED_HOST") == "1"


def is_managed_worker(env: Mapping[str, str]) -> bool:
    return env.get("QUORUM_MANAGED_WORKER") == "1"


def is_trusted_managed_worker(env: Mapping[str, str]) -> bool:
    if not is_managed_worker(env):
        return False
    supplied = env.get("QUORUM_MANAGED_WORKER_TOKEN")
    if not supplied:
        return False
    try:
        st = MANAGED_WORKER_TOKEN_PATH.stat()
        if st.st_mode & 0o077:
            return False
        expected = MANAGED_WORKER_TOKEN_PATH.read_text().strip()
    except OSError:
        return False
    return bool(expected) and hmac.compare_digest(supplied, expected)


def load_target_profile(profile_root: Path, target: str) -> TargetProfile:
    if _TARGET_RE.fullmatch(target) is None:
        raise TargetProfileError(f"invalid target profile name: {target!r}")
    path = profile_root / f"{target}.env"
    if not path.is_file():
        raise TargetProfileError(f"target profile not found: {path}")

    values: dict[str, str] = {}
    for line_no, raw_line in enumerate(path.read_text().splitlines(), 1):
        line = raw_line.strip()
        if not line or line.startswith("#"):
            continue
        try:
            parts = shlex.split(raw_line, comments=True, posix=True)
        except ValueError as exc:
            raise TargetProfileError(f"{path}:{line_no}: malformed shell assignment") from exc
        if not parts:
            continue
        if parts[0] == "export":
            parts = parts[1:]
        if len(parts) != 1 or "=" not in parts[0]:
            raise TargetProfileError(f"{path}:{line_no}: unsupported target profile line")
        name, value = parts[0].split("=", 1)
        if _ENV_NAME_RE.fullmatch(name) is None:
            raise TargetProfileError(f"{path}:{line_no}: invalid environment variable name")
        values[name] = value
    return TargetProfile(target=target, path=path, env=values)


def build_managed_env(
    base_env: Mapping[str, str],
    paths: ManagedPaths,
    target_profile: TargetProfile,
    runtime_vars: Mapping[str, str],
) -> dict[str, str]:
    env = {name: base_env[name] for name in _BASE_ENV_ALLOWLIST if base_env.get(name)}
    env.setdefault("PATH", os.defpath)
    env.setdefault("LANG", "C.UTF-8")
    env.update(dict(target_profile.env))
    env.update(
        {
            key: value
            for key, value in runtime_vars.items()
            if (key.startswith("QUORUM_") or key in _RUNTIME_ENV_ALLOWLIST)
            and key not in _CONTROLLER_ENV_KEYS
        }
    )
    env["QUORUM_ARTIFACT_ROOT"] = str(paths.artifact_root)
    env["QUORUM_STATE_ROOT"] = str(paths.state_root)
    env["QUORUM_TARGET"] = target_profile.target
    env["QUORUM_TARGET_ENV_KEYS"] = ",".join(sorted(target_profile.env))
    return env


def redact_env_for_logs(env: Mapping[str, str]) -> dict[str, str]:
    return {key: "[redacted]" for key in env}


def assert_raw_command_allowed(command_name: str, env: Mapping[str, str]) -> None:
    if (
        command_name in {"run", "run-all"}
        and is_managed_host(env)
        and not is_trusted_managed_worker(env)
    ):
        raise PermissionError(RAW_COMMAND_DISABLED_MESSAGE)
