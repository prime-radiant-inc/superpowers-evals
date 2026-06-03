from __future__ import annotations

import json
import shlex
import stat
import tempfile
from collections.abc import Mapping
from pathlib import Path


class KimiConfigError(RuntimeError):
    """Raised when Kimi provisioning or preflight cannot run safely."""


ALLOWED_HOST_KIMI_MODEL_ENV = {"KIMI_MODEL_API_KEY", "KIMI_MODEL_NAME"}
DEFAULT_KIMI_MODEL_ENV = {
    "KIMI_MODEL_NAME": "kimi-for-coding",
    "KIMI_MODEL_PROVIDER_TYPE": "kimi",
    "KIMI_MODEL_BASE_URL": "https://api.kimi.com/coding/v1",
    "KIMI_MODEL_MAX_CONTEXT_SIZE": "262144",
    "KIMI_MODEL_CAPABILITIES": "thinking,image_in,video_in,tool_use",
    "KIMI_MODEL_DEFAULT_THINKING": "true",
}
KIMI_RUNTIME_FLAGS = {
    "KIMI_DISABLE_TELEMETRY": "1",
    "KIMI_DISABLE_CRON": "1",
    "KIMI_CODE_BACKGROUND_KEEP_ALIVE_ON_EXIT": "false",
}
KIMI_CONFIG_SUMMARY_ENV = (
    set(DEFAULT_KIMI_MODEL_ENV) | set(KIMI_RUNTIME_FLAGS) | {"KIMI_MODEL_API_KEY"}
)


def effective_kimi_model_env(env: Mapping[str, str]) -> dict[str, str]:
    unknown = sorted(
        key
        for key in env
        if key.startswith("KIMI_MODEL_") and key not in ALLOWED_HOST_KIMI_MODEL_ENV
    )
    if unknown:
        raise KimiConfigError("unsupported host KIMI_MODEL_* override(s): " + ", ".join(unknown))
    api_key = env.get("KIMI_MODEL_API_KEY")
    if not api_key:
        raise KimiConfigError("KIMI_MODEL_API_KEY is required for Kimi evals")
    merged = {**DEFAULT_KIMI_MODEL_ENV, **KIMI_RUNTIME_FLAGS}
    merged["KIMI_MODEL_API_KEY"] = api_key
    if env.get("KIMI_MODEL_NAME"):
        merged["KIMI_MODEL_NAME"] = env["KIMI_MODEL_NAME"]
    return merged


def build_kimi_subprocess_env(
    *,
    base_env: Mapping[str, str],
    kimi_home: Path,
    cwd: Path,
    kimi_model_env: Mapping[str, str],
) -> dict[str, str]:
    allow_exact = {"PATH", "TERM", "LANG", "SHELL"}
    out = {key: value for key, value in base_env.items() if key in allow_exact}
    for key, value in base_env.items():
        if key.startswith("LC_") or key.lower().endswith("_proxy"):
            out[key] = value
    out.update(kimi_model_env)
    out["HOME"] = str(kimi_home / "home")
    out["KIMI_CODE_HOME"] = str(kimi_home)
    out["KIMI_CODE_CACHE_DIR"] = str(kimi_home / "cache")
    out["XDG_CONFIG_HOME"] = str(kimi_home / "xdg-config")
    out["XDG_CACHE_HOME"] = str(kimi_home / "xdg-cache")
    out["XDG_DATA_HOME"] = str(kimi_home / "xdg-data")
    out["PWD"] = str(cwd)
    return out


def _shell_assignment(key: str, value: str) -> str:
    return f"{key}={shlex.quote(value)}"


def _kimi_runtime_env_temp_parent(run_dir: Path) -> Path:
    run_dir_resolved = run_dir.resolve()
    artifact_root_resolved = run_dir_resolved.parent
    temp_parent = Path(tempfile.gettempdir()).resolve()
    if temp_parent.is_relative_to(artifact_root_resolved):
        temp_parent = artifact_root_resolved.parent
    temp_parent.mkdir(parents=True, exist_ok=True)
    if temp_parent.resolve().is_relative_to(artifact_root_resolved):
        raise KimiConfigError("Kimi runtime env temp directory resolved inside artifact root")
    return temp_parent


def write_kimi_runtime_env_file(env: Mapping[str, str], *, run_dir: Path) -> Path:
    temp_parent = _kimi_runtime_env_temp_parent(run_dir)
    secret_dir = Path(tempfile.mkdtemp(prefix=f"quorum-kimi-env-{run_dir.name}-", dir=temp_parent))
    path = secret_dir / "kimi-runtime.env"
    path.write_text("".join(_shell_assignment(k, v) + "\n" for k, v in sorted(env.items())))
    path.chmod(stat.S_IRUSR | stat.S_IWUSR)
    return path


def write_effective_kimi_config(
    kimi_home: Path,
    env: Mapping[str, str],
    *,
    kimi_binary: str | None,
    kimi_version: str | None,
) -> Path:
    payload = {
        "kimi_binary": kimi_binary,
        "kimi_version": kimi_version,
        "model_env": {
            key: ("<present>" if key == "KIMI_MODEL_API_KEY" else value)
            for key, value in sorted(env.items())
            if key in KIMI_CONFIG_SUMMARY_ENV
        },
    }
    path = kimi_home / "effective-kimi-model-config.json"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, indent=2) + "\n")
    return path
