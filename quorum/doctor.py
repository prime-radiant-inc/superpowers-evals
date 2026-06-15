"""Side-effect-free readiness checks for quorum Coding-Agent targets."""

from __future__ import annotations

import json
import os
import re
import shutil
import stat
from collections.abc import Mapping
from dataclasses import dataclass
from enum import Enum
from pathlib import Path

import yaml

from quorum.coding_agent_config import (
    CodingAgentConfig,
    CodingAgentConfigError,
    load_coding_agent_config,
)
from quorum.managed_state import ManagedPaths, discover_managed_paths
from quorum.run_all import build_matrix
from quorum.runtime_env import (
    TargetProfile,
    TargetProfileError,
    build_managed_env,
    is_managed_host,
    load_target_profile,
)

DEFAULT_PROFILE_ROOT = Path("/etc/quorum/target-profiles.d")
DEFAULT_PROFILE_OWNER_UID = 0
DEFAULT_PROFILE_FILE_MODE = 0o600
DEFAULT_PROFILE_DIR_MODE = 0o700
_NON_SECRET_REQUIRED_ENV = frozenset(
    {
        "SUPERPOWERS_ROOT",
        "PATH",
        "HOME",
        "TMPDIR",
        "LANG",
        "LC_ALL",
    }
)
_MANAGED_PROFILE_REQUIRED_ENV = {
    "claude": ("ANTHROPIC_API_KEY",),
    "claude-haiku": ("ANTHROPIC_API_KEY",),
    "claude-sonnet": ("ANTHROPIC_API_KEY",),
    "gemini": ("GEMINI_API_KEY",),
    "kimi": ("KIMI_MODEL_API_KEY",),
    "opencode": ("OPENAI_API_KEY",),
    "pi": ("PI_PROVIDER", "PI_MODEL", "PI_API_KEY"),
    "copilot": ("COPILOT_PROVIDER_BASE_URL", "COPILOT_PROVIDER_TYPE"),
}
_MANAGED_PROFILE_ALTERNATIVES = {
    "copilot": (("COPILOT_PROVIDER_API_KEY", "COPILOT_PROVIDER_BEARER_TOKEN"),),
}
_MANAGED_UNSUPPORTED_TARGETS = {
    "codex": "key-backed Codex mode has not been implemented and verified",
    "antigravity": "key-backed Antigravity mode has not been implemented and verified",
    "opencode": (
        "OpenCode managed env narrowing is not yet accepted; block until launcher "
        "and export allowlists are restricted to the selected OpenAI profile"
    ),
}
_SUPERPOWERS_REQUIRED_FILES = {
    "claude": (".claude-plugin/plugin.json", "skills/using-superpowers/SKILL.md"),
    "gemini": (
        "GEMINI.md",
        "skills/using-superpowers/SKILL.md",
        "skills/using-superpowers/references/gemini-tools.md",
    ),
    "kimi": (
        ".kimi-plugin/plugin.json",
        "skills/using-superpowers/SKILL.md",
        "skills/brainstorming/SKILL.md",
    ),
    "copilot": (
        ".claude-plugin/plugin.json",
        "hooks/hooks.json",
        "hooks/run-hook.cmd",
        "hooks/session-start",
        "skills/using-superpowers/SKILL.md",
        "skills/brainstorming/SKILL.md",
        "skills/using-superpowers/references/copilot-tools.md",
    ),
    "opencode": (
        ".opencode/plugins/superpowers.js",
        "skills/using-superpowers/SKILL.md",
        "skills/brainstorming/SKILL.md",
    ),
    "pi": (
        "skills/using-superpowers/SKILL.md",
        "skills/using-superpowers/references/pi-tools.md",
    ),
}
_COPILOT_HOOK_ENV_NAMES = frozenset({"ANTHROPIC_API_KEY", "OPENAI_API_KEY"})
_COPILOT_HOOK_ENV_FILES = ("hooks/hooks.json", "hooks/run-hook.cmd", "hooks/session-start")
_ENV_REFERENCE_RE = re.compile(r"\b[A-Z][A-Z0-9_]*\b")


class DoctorStatus(Enum):
    READY = "ready"
    BLOCKED = "blocked"
    FAILED = "failed"


@dataclass(frozen=True)
class DoctorCheck:
    name: str
    status: DoctorStatus
    message: str
    remediation: str | None = None
    reason: str | None = None

    def to_dict(self) -> dict[str, str]:
        data = {
            "name": self.name,
            "status": self.status.value,
            "message": self.message,
        }
        if self.reason:
            data["reason"] = self.reason
        if self.remediation:
            data["remediation"] = self.remediation
        return data


@dataclass(frozen=True)
class DoctorPaths:
    coding_agents_dir: Path = Path("coding-agents")
    scenarios_root: Path = Path("scenarios")
    profile_root: Path | None = None
    managed_paths: ManagedPaths | None = None
    profile_owner_uid: int | None = None


@dataclass(frozen=True)
class TargetDoctorResult:
    target: str
    status: DoctorStatus
    checks: list[DoctorCheck]

    def to_dict(self) -> dict[str, object]:
        return {
            "target": self.target,
            "status": self.status.value,
            "checks": [check.to_dict() for check in self.checks],
        }

    def to_json(self) -> str:
        return json.dumps(self.to_dict(), sort_keys=True)


def run_target_doctor(
    target: str,
    paths: DoctorPaths,
    env: Mapping[str, str],
) -> TargetDoctorResult:
    checks: list[DoctorCheck] = []
    profile: TargetProfile | None = None
    cfg: CodingAgentConfig | None = None
    config_path = paths.coding_agents_dir / f"{target}.yaml"

    if not config_path.is_file():
        checks.append(
            DoctorCheck(
                "coding-agent-config",
                DoctorStatus.FAILED,
                f"coding-agent config not found: {config_path}",
                remediation=f"add {config_path} or choose a configured target",
                reason="missing-repo-file",
            )
        )
        return TargetDoctorResult(target=target, status=_rollup(checks), checks=checks)

    required_env_names = _read_required_env_names(config_path)
    try:
        cfg = load_coding_agent_config(config_path, env=_doctor_config_env(env, required_env_names))
    except (CodingAgentConfigError, OSError, TypeError, yaml.YAMLError) as exc:
        checks.append(
            DoctorCheck(
                "coding-agent-config",
                DoctorStatus.FAILED,
                f"coding-agent config failed to load: {exc}",
                remediation=f"fix {config_path}",
                reason="config-error",
            )
        )
        return TargetDoctorResult(target=target, status=_rollup(checks), checks=checks)
    checks.append(
        DoctorCheck(
            "coding-agent-config",
            DoctorStatus.READY,
            f"loaded {config_path}",
        )
    )

    managed = is_managed_host(env)
    target_env: Mapping[str, str] = env

    if managed and target in _MANAGED_UNSUPPORTED_TARGETS:
        checks.append(
            DoctorCheck(
                "target-profile",
                DoctorStatus.READY,
                "target profile is not required until key-backed mode is verified",
            )
        )
        checks.append(_check_required_credentials(target, cfg, None, target_env, managed=managed))
        return TargetDoctorResult(target=target, status=_rollup(checks), checks=checks)

    profile_root = _profile_root(paths, env)
    if managed:
        try:
            profile = load_target_profile(profile_root, target)
        except TargetProfileError as exc:
            reason = "missing-secret" if "not found" in str(exc) else "config-error"
            checks.append(
                DoctorCheck(
                    "target-profile",
                    DoctorStatus.FAILED,
                    str(exc),
                    remediation=(
                        f"create {profile_root / f'{target}.env'} with required credentials"
                    ),
                    reason=reason,
                )
            )
            return TargetDoctorResult(target=target, status=_rollup(checks), checks=checks)
        else:
            checks.append(
                DoctorCheck(
                    "target-profile",
                    DoctorStatus.READY,
                    f"loaded {profile.path}",
                )
            )
            checks.append(_check_profile_permissions(profile.path, paths.profile_owner_uid))
            managed_paths = paths.managed_paths or discover_managed_paths(env)
            try:
                target_env = build_managed_env(
                    env,
                    managed_paths,
                    profile,
                    runtime_vars={},
                )
            except Exception as exc:
                checks.append(
                    DoctorCheck(
                        "sanitized-env",
                        DoctorStatus.FAILED,
                        f"could not build sanitized target env: {exc}",
                        remediation="fix target profile or managed root configuration",
                        reason="config-error",
                    )
                )
            else:
                checks.append(
                    DoctorCheck(
                        "sanitized-env",
                        DoctorStatus.READY,
                        "sanitized target env materialized from profile and allowlisted base env",
                    )
                )
    else:
        checks.append(
            DoctorCheck(
                "target-profile",
                DoctorStatus.READY,
                "managed host mode inactive; target profile is not required",
            )
        )

    checks.extend(_check_managed_paths(paths, env, managed=managed))
    checks.append(_check_required_credentials(target, cfg, profile, target_env, managed=managed))
    checks.append(_check_binary(cfg, target_env, managed=managed))
    checks.append(_check_context(paths.coding_agents_dir, cfg))
    checks.append(_check_home_skeleton(paths.coding_agents_dir, cfg))
    checks.append(_check_superpowers_files(target, cfg, target_env, managed=managed))
    checks.append(_check_sentinel(paths, target))

    return TargetDoctorResult(target=target, status=_rollup(checks), checks=checks)


def run_all_doctors(paths: DoctorPaths, env: Mapping[str, str]) -> list[TargetDoctorResult]:
    if not paths.coding_agents_dir.is_dir():
        return [
            TargetDoctorResult(
                target="*",
                status=DoctorStatus.FAILED,
                checks=[
                    DoctorCheck(
                        "coding-agent-config",
                        DoctorStatus.FAILED,
                        f"coding-agents directory not found: {paths.coding_agents_dir}",
                        remediation="pass --coding-agents-dir pointing at a checkout",
                        reason="config-error",
                    )
                ],
            )
        ]
    targets = sorted(path.stem for path in paths.coding_agents_dir.glob("*.yaml"))
    return [run_target_doctor(target, paths, env) for target in targets]


def _rollup(checks: list[DoctorCheck]) -> DoctorStatus:
    if any(check.status is DoctorStatus.FAILED for check in checks):
        return DoctorStatus.FAILED
    if any(check.status is DoctorStatus.BLOCKED for check in checks):
        return DoctorStatus.BLOCKED
    return DoctorStatus.READY


def is_doctor_command_error(result: TargetDoctorResult) -> bool:
    """Return true when doctor could not complete classification for a target."""
    command_error_checks = {"artifact-root", "coding-agent-config", "state-root"}
    return any(
        check.status is DoctorStatus.FAILED
        and check.reason == "config-error"
        and check.name in command_error_checks
        for check in result.checks
    )


def _profile_root(paths: DoctorPaths, env: Mapping[str, str]) -> Path:
    if paths.profile_root is not None:
        return paths.profile_root
    if env.get("QUORUM_TARGET_PROFILE_ROOT"):
        return Path(env["QUORUM_TARGET_PROFILE_ROOT"])
    return DEFAULT_PROFILE_ROOT


def _read_required_env_names(config_path: Path) -> tuple[str, ...]:
    try:
        raw = yaml.safe_load(config_path.read_text()) or {}
    except (OSError, yaml.YAMLError):
        return ()
    if not isinstance(raw, Mapping):
        return ()
    required = raw.get("required_env", ())
    if not isinstance(required, list | tuple):
        return ()
    return tuple(str(name) for name in required)


def _doctor_config_env(
    env: Mapping[str, str],
    required_env_names: tuple[str, ...],
) -> dict[str, str]:
    cfg_env = dict(env)
    for name in required_env_names:
        cfg_env[name] = f"__quorum_doctor_placeholder_{name}__"
    return cfg_env


def _check_profile_permissions(
    profile_path: Path | None,
    profile_owner_uid: int | None,
) -> DoctorCheck:
    if profile_path is None:
        return DoctorCheck(
            "profile-permissions",
            DoctorStatus.FAILED,
            "target profile path was not available after profile load",
            reason="config-error",
        )
    expected_owner_uid = (
        DEFAULT_PROFILE_OWNER_UID if profile_owner_uid is None else profile_owner_uid
    )
    try:
        profile_stat = profile_path.stat()
        profile_dir_stat = profile_path.parent.stat()
    except OSError as exc:
        return DoctorCheck(
            "profile-permissions",
            DoctorStatus.FAILED,
            f"target profile metadata could not be read: {exc}",
            remediation=f"fix profile path permissions for {profile_path}",
            reason="config-error",
        )

    if profile_dir_stat.st_uid != expected_owner_uid:
        return DoctorCheck(
            "profile-permissions",
            DoctorStatus.FAILED,
            (
                f"target profile directory owner uid {profile_dir_stat.st_uid} "
                f"does not match expected uid {expected_owner_uid}: {profile_path.parent}"
            ),
            remediation=f"chown root:root {profile_path.parent}",
            reason="config-error",
        )
    dir_mode = stat.S_IMODE(profile_dir_stat.st_mode)
    if dir_mode != DEFAULT_PROFILE_DIR_MODE:
        return DoctorCheck(
            "profile-permissions",
            DoctorStatus.FAILED,
            (
                f"target profile directory mode {dir_mode:04o} "
                f"does not match {DEFAULT_PROFILE_DIR_MODE:04o}: {profile_path.parent}"
            ),
            remediation=f"chmod {DEFAULT_PROFILE_DIR_MODE:04o} {profile_path.parent}",
            reason="config-error",
        )

    if profile_stat.st_uid != expected_owner_uid:
        return DoctorCheck(
            "profile-permissions",
            DoctorStatus.FAILED,
            (
                f"target profile owner uid {profile_stat.st_uid} "
                f"does not match expected uid {expected_owner_uid}: {profile_path}"
            ),
            remediation=f"chown root:root {profile_path}",
            reason="config-error",
        )
    file_mode = stat.S_IMODE(profile_stat.st_mode)
    if file_mode != DEFAULT_PROFILE_FILE_MODE:
        return DoctorCheck(
            "profile-permissions",
            DoctorStatus.FAILED,
            (
                f"target profile mode {file_mode:04o} "
                f"does not match {DEFAULT_PROFILE_FILE_MODE:04o}: {profile_path}"
            ),
            remediation=f"chmod {DEFAULT_PROFILE_FILE_MODE:04o} {profile_path}",
            reason="config-error",
        )
    return DoctorCheck(
        "profile-permissions",
        DoctorStatus.READY,
        f"target profile owner and permissions are private: {profile_path}",
    )


def _check_managed_paths(
    paths: DoctorPaths,
    env: Mapping[str, str],
    *,
    managed: bool,
) -> list[DoctorCheck]:
    if not managed:
        return []

    managed_paths = paths.managed_paths or discover_managed_paths(env)
    return [
        _check_path_writable("artifact-root", managed_paths.artifact_root),
        _check_path_writable("state-root", managed_paths.state_root),
    ]


def _check_path_writable(name: str, path: Path) -> DoctorCheck:
    probe = path if path.exists() else _nearest_existing_parent(path)
    if probe is None:
        return DoctorCheck(
            name,
            DoctorStatus.FAILED,
            f"no existing parent found for {path}",
            remediation=f"create a writable parent for {path}",
            reason="config-error",
        )
    if path.is_symlink():
        return DoctorCheck(
            name,
            DoctorStatus.FAILED,
            f"{path} is a symlink, not a managed directory",
            remediation=f"replace {path} with a writable directory",
            reason="config-error",
        )
    if path.exists() and not path.is_dir():
        return DoctorCheck(
            name,
            DoctorStatus.FAILED,
            f"{path} exists but is not a directory",
            remediation=f"replace {path} with a writable directory",
            reason="config-error",
        )
    if probe.is_symlink():
        return DoctorCheck(
            name,
            DoctorStatus.FAILED,
            f"nearest existing parent for {path} is a symlink: {probe}",
            remediation=f"replace {probe} with a writable directory",
            reason="config-error",
        )
    if not probe.is_dir():
        return DoctorCheck(
            name,
            DoctorStatus.FAILED,
            f"nearest existing parent for {path} is not a directory: {probe}",
            remediation=f"replace {probe} with a writable directory",
            reason="config-error",
        )
    if not os.access(probe, os.W_OK | os.X_OK):
        return DoctorCheck(
            name,
            DoctorStatus.FAILED,
            f"{path} is not writable by this user",
            remediation=f"grant write access to {path}",
            reason="config-error",
        )
    if path.exists():
        return DoctorCheck(name, DoctorStatus.READY, f"{path} is writable")
    return DoctorCheck(name, DoctorStatus.READY, f"{path} can be created")


def _nearest_existing_parent(path: Path) -> Path | None:
    current = path
    while not current.exists() and not current.is_symlink():
        parent = current.parent
        if parent == current:
            return None
        current = parent
    return current


def _check_required_credentials(
    target: str,
    cfg: CodingAgentConfig,
    profile: TargetProfile | None,
    env: Mapping[str, str],
    *,
    managed: bool,
) -> DoctorCheck:
    if managed:
        if target in _MANAGED_UNSUPPORTED_TARGETS:
            return DoctorCheck(
                "required-credentials",
                DoctorStatus.BLOCKED,
                _MANAGED_UNSUPPORTED_TARGETS[target],
                remediation="verify a key-backed CLI auth contract before enabling this target",
                reason="unsupported-key-backed-mode",
            )
        profile_env = profile.env if profile is not None else {}
        personal_auth = _check_personal_auth(target, profile_env)
        if personal_auth is not None:
            return personal_auth
        required_profile_vars = sorted({
            name for name in cfg.required_env if name not in _NON_SECRET_REQUIRED_ENV
        } | set(_MANAGED_PROFILE_REQUIRED_ENV.get(target, ())))
        missing = [name for name in required_profile_vars if not profile_env.get(name)]
        alternatives_groups = _managed_profile_alternatives(target, env)
        for alternatives in alternatives_groups:
            if not any(profile_env.get(name) for name in alternatives):
                missing.append(" or ".join(alternatives))
        if missing:
            return DoctorCheck(
                "required-credentials",
                DoctorStatus.FAILED,
                f"target profile is missing required credential variables: {', '.join(missing)}",
                remediation="add the missing variables to the target profile",
                reason="missing-secret",
            )
        placeholders = [
            name
            for name in required_profile_vars
            if _looks_like_placeholder_secret(profile_env.get(name, ""))
        ]
        for alternatives in alternatives_groups:
            placeholders.extend(
                name
                for name in alternatives
                if profile_env.get(name) and _looks_like_placeholder_secret(profile_env[name])
            )
        if placeholders:
            placeholder_names = ", ".join(placeholders)
            return DoctorCheck(
                "required-credentials",
                DoctorStatus.FAILED,
                f"target profile contains placeholder credential variables: {placeholder_names}",
                remediation="replace placeholder values with real host-managed credentials",
                reason="placeholder-secret",
            )
        missing_base = [
            name
            for name in cfg.required_env
            if name in _NON_SECRET_REQUIRED_ENV and not env.get(name) and not profile_env.get(name)
        ]
        if missing_base:
            return DoctorCheck(
                "required-credentials",
                DoctorStatus.FAILED,
                f"environment is missing required operational variables: {', '.join(missing_base)}",
                remediation="set the missing variables in the managed base environment",
                reason="config-error",
            )
    else:
        missing = [name for name in cfg.required_env if not env.get(name)]
        if missing:
            return DoctorCheck(
                "required-credentials",
                DoctorStatus.BLOCKED,
                f"environment is missing required variables: {', '.join(missing)}",
                remediation="export the missing variables before running quorum",
                reason="missing-secret",
            )
    return DoctorCheck(
        "required-credentials",
        DoctorStatus.READY,
        "required variables are available",
    )


def _check_personal_auth(target: str, profile_env: Mapping[str, str]) -> DoctorCheck | None:
    if target == "gemini":
        auth_type = (profile_env.get("GEMINI_AUTH_TYPE") or "gemini-api-key").strip()
        if not auth_type:
            auth_type = "gemini-api-key"
        if auth_type == "oauth-personal":
            return DoctorCheck(
                "required-credentials",
                DoctorStatus.BLOCKED,
                "GEMINI_AUTH_TYPE=oauth-personal is personal auth and is not supported",
                remediation="use GEMINI_AUTH_TYPE=gemini-api-key with GEMINI_API_KEY",
                reason="personal-auth",
            )
        if auth_type != "gemini-api-key":
            return DoctorCheck(
                "required-credentials",
                DoctorStatus.FAILED,
                f"unsupported GEMINI_AUTH_TYPE: {auth_type}",
                remediation="set GEMINI_AUTH_TYPE=gemini-api-key or omit it",
                reason="config-error",
            )

    if target == "copilot":
        personal_names = ("COPILOT_GITHUB_TOKEN", "GH_TOKEN", "GITHUB_TOKEN")
        present = [name for name in personal_names if profile_env.get(name)]
        if present:
            present_names = ", ".join(present)
            return DoctorCheck(
                "required-credentials",
                DoctorStatus.BLOCKED,
                f"Copilot GitHub-token auth is not supported on managed hosts: {present_names}",
                remediation="use provider mode with COPILOT_PROVIDER_* credentials",
                reason="personal-auth",
            )

    return None


def _managed_profile_alternatives(
    target: str,
    env: Mapping[str, str],
) -> tuple[tuple[str, ...], ...]:
    alternatives = list(_MANAGED_PROFILE_ALTERNATIVES.get(target, ()))
    if target == "copilot":
        required_hook_env = _copilot_hook_env_references(env.get("SUPERPOWERS_ROOT", ""))
        if required_hook_env:
            alternatives.append(tuple(required_hook_env))
    return tuple(alternatives)


def _copilot_hook_env_references(superpowers_root: str) -> tuple[str, ...]:
    if not superpowers_root:
        return ()
    root = Path(superpowers_root).expanduser()
    refs: set[str] = set()
    for rel in _COPILOT_HOOK_ENV_FILES:
        path = root / rel
        try:
            if not path.is_file() or path.stat().st_size > 512_000:
                continue
            refs.update(_ENV_REFERENCE_RE.findall(path.read_text(errors="ignore")))
        except OSError:
            continue
    return tuple(sorted(refs & _COPILOT_HOOK_ENV_NAMES))


def _looks_like_placeholder_secret(value: str) -> bool:
    normalized = value.strip().lower()
    return normalized in {
        "changeme",
        "change-me",
        "dummy",
        "example",
        "placeholder",
        "redacted",
        "replace-me",
        "todo",
    } or normalized.startswith("__quorum_doctor_placeholder_")


def _check_binary(
    cfg: CodingAgentConfig,
    env: Mapping[str, str],
    *,
    managed: bool,
) -> DoctorCheck:
    path_value = env.get("PATH") or os.defpath
    found = shutil.which(cfg.binary, path=path_value)
    if found is None:
        return DoctorCheck(
            "local-tool",
            DoctorStatus.FAILED if managed else DoctorStatus.BLOCKED,
            f"required local tool is not on PATH: {cfg.binary}",
            remediation=f"install {cfg.binary} or add it to PATH",
            reason="missing-binary",
        )
    return DoctorCheck("local-tool", DoctorStatus.READY, f"found {cfg.binary} at {found}")


def _check_context(coding_agents_dir: Path, cfg: CodingAgentConfig) -> DoctorCheck:
    context = coding_agents_dir / f"{cfg.runtime_family}-context"
    if not context.is_dir():
        return DoctorCheck(
            "context-directory",
            DoctorStatus.FAILED,
            f"required context directory missing: {context}",
            remediation=f"add {context}",
            reason="missing-repo-file",
        )
    return DoctorCheck("context-directory", DoctorStatus.READY, f"found {context}")


def _check_home_skeleton(coding_agents_dir: Path, cfg: CodingAgentConfig) -> DoctorCheck:
    skeleton = coding_agents_dir / f"{cfg.runtime_family}-home-skeleton"
    if skeleton.exists() and not skeleton.is_dir():
        return DoctorCheck(
            "home-skeleton",
            DoctorStatus.FAILED,
            f"home skeleton path is not a directory: {skeleton}",
            remediation=f"replace {skeleton} with a directory or remove it",
            reason="config-error",
        )
    if skeleton.is_dir():
        return DoctorCheck("home-skeleton", DoctorStatus.READY, f"found {skeleton}")
    return DoctorCheck(
        "home-skeleton",
        DoctorStatus.READY,
        f"no home skeleton required for runtime family {cfg.runtime_family}",
    )


def _check_superpowers_files(
    target: str,
    cfg: CodingAgentConfig,
    env: Mapping[str, str],
    *,
    managed: bool,
) -> DoctorCheck:
    required = _SUPERPOWERS_REQUIRED_FILES.get(target) or _SUPERPOWERS_REQUIRED_FILES.get(
        cfg.runtime_family,
        ("skills/using-superpowers/SKILL.md",),
    )
    root_text = env.get("SUPERPOWERS_ROOT", "")
    if not root_text:
        return DoctorCheck(
            "superpowers-files",
            DoctorStatus.FAILED if managed else DoctorStatus.BLOCKED,
            "SUPERPOWERS_ROOT is not set",
            remediation="set SUPERPOWERS_ROOT to the Superpowers checkout",
            reason="missing-repo-file",
        )
    root = Path(root_text).expanduser()
    missing = [rel for rel in required if not (root / rel).is_file()]
    if missing:
        return DoctorCheck(
            "superpowers-files",
            DoctorStatus.FAILED,
            "SUPERPOWERS_ROOT is missing required files: " + ", ".join(missing),
            remediation=f"point SUPERPOWERS_ROOT at a complete Superpowers checkout: {root}",
            reason="missing-repo-file",
        )
    return DoctorCheck(
        "superpowers-files",
        DoctorStatus.READY,
        f"required Superpowers files found under {root}",
    )


def _check_sentinel(paths: DoctorPaths, target: str) -> DoctorCheck:
    try:
        entries = build_matrix(
            scenarios_root=paths.scenarios_root,
            coding_agents_dir=paths.coding_agents_dir,
            agent_filter=[target],
            tier_filter="sentinel",
            include_drafts=False,
        )
    except ValueError as exc:
        return DoctorCheck(
            "sentinel-scenario",
            DoctorStatus.FAILED,
            f"could not build sentinel matrix: {exc}",
            remediation="fix scenario metadata or coding-agent configuration",
            reason="config-error",
        )
    runnable = [entry.scenario for entry in entries if entry.runnable]
    if not runnable:
        return DoctorCheck(
            "sentinel-scenario",
            DoctorStatus.FAILED,
            f"no runnable sentinel scenario found for target {target}",
            remediation="add a ready quorum_tier: sentinel scenario for this target",
            reason="missing-repo-file",
        )
    return DoctorCheck(
        "sentinel-scenario",
        DoctorStatus.READY,
        f"runnable sentinel scenario available: {runnable[0]}",
    )
