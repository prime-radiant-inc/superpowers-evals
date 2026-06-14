from __future__ import annotations

import contextlib
import datetime as _dt
import hashlib
import json
import os
import shlex
import shutil
import stat
import subprocess
import tempfile
from collections.abc import Mapping
from pathlib import Path
from typing import cast


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
_SENSITIVE_ENV_NAME_PARTS = ("KEY", "TOKEN", "SECRET", "PASSWORD")
_MIN_SENSITIVE_VALUE_LEN = 6


def resolve_kimi_binary(binary: str) -> str:
    resolved = shutil.which(binary)
    if resolved is None:
        raise KimiConfigError(f"{binary!r} not found on PATH; cannot run Kimi evals")
    return resolved


def kimi_preflight_sentinel_payload(
    *,
    kimi_binary: str,
    kimi_model_env: Mapping[str, str],
    preflight_token: str,
) -> dict[str, str | int]:
    return {
        "schema": 1,
        "agent": "kimi",
        "kimi_binary": kimi_binary,
        "model": kimi_model_env["KIMI_MODEL_NAME"],
        "provider": kimi_model_env["KIMI_MODEL_PROVIDER_TYPE"],
        "base_url": kimi_model_env["KIMI_MODEL_BASE_URL"],
        "preflight_token_sha256": hashlib.sha256(preflight_token.encode()).hexdigest(),
    }


def validate_kimi_preflight_sentinel(
    path: Path,
    *,
    kimi_binary: str,
    kimi_model_env: Mapping[str, str],
    preflight_token: str | None,
) -> None:
    if not path.is_file():
        raise KimiConfigError(f"Kimi preflight sentinel missing: {path}")
    try:
        payload = json.loads(path.read_text())
    except json.JSONDecodeError as e:
        raise KimiConfigError(f"Kimi preflight sentinel is not valid JSON: {e}") from e
    except OSError as e:
        raise KimiConfigError(f"Kimi preflight sentinel could not be read: {e}") from e
    if not isinstance(payload, dict):
        raise KimiConfigError("Kimi preflight sentinel must be a JSON object")
    if preflight_token is None or not preflight_token.strip():
        raise KimiConfigError("Kimi preflight sentinel token missing or malformed")

    expected = kimi_preflight_sentinel_payload(
        kimi_binary=kimi_binary,
        kimi_model_env=kimi_model_env,
        preflight_token=preflight_token,
    )
    for key, expected_value in expected.items():
        actual = payload.get(key)
        if actual != expected_value:
            raise KimiConfigError(
                "Kimi preflight sentinel "
                f"{key} mismatch: expected {expected_value!r}, got {actual!r}"
            )


def sanitize_kimi_diagnostic(message: object, env: Mapping[str, str] = os.environ) -> str:
    text: str = str(message)
    values: set[str] = set()
    api_key = env.get("KIMI_MODEL_API_KEY")
    if api_key:
        values.add(str(api_key))
    for key, value in env.items():
        if (
            value
            and len(value) >= _MIN_SENSITIVE_VALUE_LEN
            and any(part in key.upper() for part in _SENSITIVE_ENV_NAME_PARTS)
        ):
            values.add(str(value))
    ordered_values = list(values)
    ordered_values.sort(key=lambda value: len(value), reverse=True)
    for value in ordered_values:
        text = text.replace(value, "<redacted>")
    return text


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
    return out


def _normalized_ok(text: str) -> bool:
    return text.strip().rstrip(".!").strip().upper() == "OK"


def kimi_stream_json_reply_ok(stdout: str) -> bool:
    assistant_parts: list[str] = []
    for line in stdout.splitlines():
        if not line.strip():
            continue
        try:
            row = json.loads(line)
        except json.JSONDecodeError:
            continue
        if not isinstance(row, dict):
            continue
        role = row.get("role")
        if role is not None:
            is_assistant = role == "assistant"
        else:
            is_assistant = row.get("type") in {"assistant", "message", "response"}
        if is_assistant:
            content = row.get("content")
            if isinstance(content, str):
                assistant_parts.append(content)
            elif isinstance(content, list):
                assistant_parts.extend(
                    part.get("text", "")
                    for part in content
                    if isinstance(part, dict) and isinstance(part.get("text"), str)
                )
    return _normalized_ok("".join(assistant_parts))


def _kimi_message_text(row: dict[str, object]) -> str:
    message_obj = row.get("message")
    if not isinstance(message_obj, dict):
        return ""
    message = cast(dict[str, object], message_obj)
    content = message.get("content")
    if isinstance(content, str):
        return content
    if not isinstance(content, list):
        return ""
    parts: list[str] = []
    for part in content:
        if isinstance(part, str):
            parts.append(part)
        elif isinstance(part, dict):
            text = cast(dict[str, object], part).get("text")
            if isinstance(text, str):
                parts.append(text)
    return "\n".join(parts)


def _kimi_injection_origin(row: dict[str, object]) -> object:
    origin = row.get("origin")
    if origin is not None:
        return origin
    message_obj = row.get("message")
    if isinstance(message_obj, dict):
        message = cast(dict[str, object], message_obj)
        return message.get("origin")
    return None


def kimi_logs_have_superpowers_session_start(paths: list[Path] | tuple[Path, ...]) -> bool:
    for path in paths:
        try:
            lines = path.read_text().splitlines()
        except OSError:
            continue
        for line in lines:
            if not line.strip():
                continue
            try:
                row = json.loads(line)
            except json.JSONDecodeError:
                continue
            if not isinstance(row, dict):
                continue
            row = cast(dict[str, object], row)
            event = row.get("event")
            if isinstance(event, dict) and (
                cast(dict[str, object], event).get("type") == "plugin_session_start"
                and cast(dict[str, object], event).get("plugin") == "superpowers"
                and cast(dict[str, object], event).get("skill") == "using-superpowers"
            ):
                return True
            origin = _kimi_injection_origin(row)
            origin_dict = cast(dict[str, object], origin) if isinstance(origin, dict) else None
            if not (
                origin_dict is not None
                and origin_dict.get("kind") == "injection"
                and origin_dict.get("variant") == "plugin_session_start"
            ):
                continue
            text = _kimi_message_text(row)
            lower_text = text.lower()
            if (
                "<plugin_session_start" in text
                and "superpowers" in lower_text
                and "using-superpowers" in lower_text
            ):
                return True
    return False


def run_kimi_auth_preflight(
    *,
    kimi_binary: str,
    kimi_model_env: Mapping[str, str],
    base_env: Mapping[str, str],
    timeout: int = 90,
) -> None:
    with tempfile.TemporaryDirectory(prefix="quorum-kimi-preflight-") as tmp:
        tmp_path = Path(tmp)
        kimi_home = tmp_path / "kimi-home"
        cwd = tmp_path / "cwd"
        cwd.mkdir()
        env = build_kimi_subprocess_env(
            base_env=base_env,
            kimi_home=kimi_home,
            cwd=cwd,
            kimi_model_env=kimi_model_env,
        )
        try:
            result = subprocess.run(
                [kimi_binary, "-p", "Reply with EXACTLY OK.", "--output-format=stream-json"],
                cwd=cwd,
                env=env,
                text=True,
                capture_output=True,
                timeout=timeout,
            )
        except subprocess.TimeoutExpired as e:
            raise KimiConfigError("kimi auth preflight timed out") from e
        if result.returncode != 0:
            stderr = result.stderr.strip()[:300]
            raise KimiConfigError(
                f"kimi auth preflight failed (exit {result.returncode}); stderr: {stderr}"
            )
        if not kimi_stream_json_reply_ok(result.stdout):
            raise KimiConfigError(
                "kimi auth preflight did not return OK; stdout: " + result.stdout.strip()[:300]
            )
        index_path = kimi_home / "session_index.jsonl"
        if not index_path.is_file():
            raise KimiConfigError("kimi auth preflight produced no session_index.jsonl")
        target = os.path.realpath(cwd)
        sessions_root = (kimi_home / "sessions").resolve()
        matched_workdir = False
        outside_session_dir = False
        matching_session_dirs: list[Path] = []
        with index_path.open() as f:
            for line in f:
                if not line.strip():
                    continue
                with contextlib.suppress(json.JSONDecodeError):
                    row = json.loads(line)
                    if (
                        isinstance(row, dict)
                        and os.path.realpath(str(row.get("workDir", ""))) == target
                    ):
                        matched_workdir = True
                        session_dir = row.get("sessionDir")
                        if isinstance(session_dir, str) and session_dir:
                            resolved_session_dir = Path(session_dir).resolve()
                            if not resolved_session_dir.is_relative_to(sessions_root):
                                outside_session_dir = True
                                continue
                            matching_session_dirs.append(resolved_session_dir)
        if not matched_workdir:
            raise KimiConfigError("kimi auth preflight session_index workDir did not match cwd")
        if not matching_session_dirs:
            if outside_session_dir:
                raise KimiConfigError("kimi auth preflight sessionDir outside Kimi home/sessions")
            raise KimiConfigError("kimi auth preflight session_index matched no sessionDir")
        for session_dir in matching_session_dirs:
            if any(session_dir.glob("**/wire.jsonl")):
                break
        else:
            raise KimiConfigError("kimi auth preflight matching sessionDir produced no wire.jsonl")


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


def validate_superpowers_kimi_root(root: str | Path) -> Path:
    resolved = Path(root).expanduser().resolve()
    manifest_path = resolved / ".kimi-plugin" / "plugin.json"
    required = [
        manifest_path,
        resolved / "skills" / "using-superpowers" / "SKILL.md",
        resolved / "skills" / "brainstorming" / "SKILL.md",
    ]
    missing = [str(path.relative_to(resolved)) for path in required if not path.is_file()]
    if missing:
        raise KimiConfigError("SUPERPOWERS_ROOT missing Kimi files: " + ", ".join(missing))
    try:
        manifest = json.loads(manifest_path.read_text())
    except json.JSONDecodeError as e:
        raise KimiConfigError(f"{manifest_path} is not valid JSON: {e}") from e
    if manifest.get("name") != "superpowers":
        raise KimiConfigError("Kimi manifest name must be superpowers")
    if manifest.get("skills") != "./skills/":
        raise KimiConfigError("Kimi manifest skills must be ./skills/")
    session_start = manifest.get("sessionStart") or {}
    if not isinstance(session_start, dict) or session_start.get("skill") != "using-superpowers":
        raise KimiConfigError("Kimi manifest sessionStart.skill must be using-superpowers")
    if not manifest.get("skillInstructions"):
        raise KimiConfigError("Kimi manifest skillInstructions must be non-empty")
    return resolved


def install_kimi_superpowers_plugin(kimi_home: Path, superpowers_root: str | Path) -> Path:
    root = validate_superpowers_kimi_root(superpowers_root)
    plugins_dir = kimi_home / "plugins"
    plugins_dir.mkdir(parents=True, exist_ok=True)
    now = _dt.datetime.now(_dt.UTC).isoformat(timespec="milliseconds").replace("+00:00", "Z")
    payload = {
        "version": 1,
        "plugins": [
            {
                "id": "superpowers",
                "root": str(root),
                "source": "local-path",
                "enabled": True,
                "installedAt": now,
                "updatedAt": now,
                "originalSource": str(root),
            }
        ],
    }
    path = plugins_dir / "installed.json"
    path.write_text(json.dumps(payload, indent=2) + "\n")
    return path
