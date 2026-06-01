"""Normalizes backend-specific session logs to a common tool call schema."""

from __future__ import annotations

import json
import os
from collections.abc import Callable
from pathlib import Path
from typing import Any

NATIVE_TOOLS: set[str] = {
    "EnterWorktree",
    "ExitWorktree",
    "EnterPlanMode",
    "ExitPlanMode",
    "TaskCreate",
    "TaskUpdate",
    "TaskList",
    "TaskGet",
    "Skill",
    "Agent",
    "Read",
    "Write",
    "Edit",
    "Glob",
    "Grep",
}

LOG_EXTENSIONS: tuple[str, ...] = ("*.jsonl", "*.json")


def snapshot_log_dir(log_dir: Path) -> set[str]:
    """Snapshot all session log files in a log directory (recursive)."""
    if not log_dir.exists():
        return set()
    files: set[str] = set()
    for ext in LOG_EXTENSIONS:
        files.update(str(f.relative_to(log_dir)) for f in log_dir.rglob(ext))
    return files


def collect_new_logs(log_dir: Path, snapshot: set[str]) -> list[Path]:
    """Find session log files created after the snapshot (recursive)."""
    if not log_dir.exists():
        return []
    current: dict[str, Path] = {}
    for ext in LOG_EXTENSIONS:
        current.update({str(f.relative_to(log_dir)): f for f in log_dir.rglob(ext)})
    new_keys: set[str] = set(current.keys()) - snapshot
    return [current[k] for k in sorted(new_keys)]


def filter_codex_logs_by_cwd(paths: list[Path], target_cwd: str) -> list[Path]:
    """Drop codex rollouts whose session_meta.cwd doesn't match target_cwd.

    Codex stores all sessions under a shared ~/.codex/sessions/ tree, so when
    multiple drill scenarios run in parallel each one's snapshot diff sees every
    other run's rollouts. Each rollout's first line is a `session_meta` event
    that records the cwd the codex CLI was launched in — use it to attribute
    rollouts to the run that produced them.

    Paths are compared after realpath resolution: macOS hands out workdirs
    under /var/folders/... but codex records the resolved /private/var/...
    realpath, so raw string equality would drop every rollout.
    """
    target = os.path.realpath(target_cwd)
    matched: list[Path] = []
    for path in paths:
        try:
            with path.open() as f:
                first_line = f.readline()
            entry = json.loads(first_line)
        except (OSError, json.JSONDecodeError):
            continue
        if entry.get("type") != "session_meta":
            continue
        cwd = entry.get("payload", {}).get("cwd", "")
        if cwd and os.path.realpath(cwd) == target:
            matched.append(path)
    return matched


def find_misplaced_codex_rollouts(
    paths: list[Path], *, run_dir: Path, launch_cwd: Path
) -> list[Path]:
    """Rollouts whose cwd is inside run_dir but isn't the expected launch_cwd.

    Smoking gun for "QA agent skipped `cd $QUORUM_AGENT_CWD` before launching
    codex" — the rollout is clearly attributable to this run (it's inside the
    run dir) but codex booted in the wrong subdirectory, so filter_codex_logs_by_cwd
    correctly excludes it from the normalized output. The runner uses this to
    distinguish that QA-agent misconfiguration from a genuine never-launched
    failure.
    """
    run_dir_real = os.path.realpath(run_dir)
    launch_cwd_real = os.path.realpath(launch_cwd)
    misplaced: list[Path] = []
    for path in paths:
        try:
            with path.open() as f:
                first_line = f.readline()
            entry = json.loads(first_line)
        except (OSError, json.JSONDecodeError):
            continue
        if entry.get("type") != "session_meta":
            continue
        cwd = entry.get("payload", {}).get("cwd", "")
        if not cwd:
            continue
        cwd_real = os.path.realpath(cwd)
        inside_run_dir = (
            cwd_real == run_dir_real or cwd_real.startswith(run_dir_real + os.sep)
        )
        if inside_run_dir and cwd_real != launch_cwd_real:
            misplaced.append(path)
    return misplaced


def filter_pi_logs_by_cwd(paths: list[Path], target_cwd: str) -> list[Path]:
    """Drop Pi sessions whose header cwd doesn't match target_cwd.

    Paths are realpath-resolved before comparison — see
    filter_codex_logs_by_cwd for why raw string equality fails on macOS.
    """
    target = os.path.realpath(target_cwd)
    matched: list[Path] = []
    for path in paths:
        try:
            with path.open() as f:
                first_line = f.readline()
            entry = json.loads(first_line)
        except (OSError, json.JSONDecodeError):
            continue
        if entry.get("type") != "session":
            continue
        cwd = entry.get("cwd", "")
        if cwd and os.path.realpath(cwd) == target:
            matched.append(path)
    return matched


def normalize_claude_logs(raw_content: str) -> list[dict[str, Any]]:
    """Normalize Claude Code session logs.

    CC logs are JSONL where assistant messages have:
    {"type": "assistant", "message": {"content": [{"type": "tool_use", "name": "...",
    "input": {...}}]}}
    """
    results: list[dict[str, Any]] = []
    for line in raw_content.strip().split("\n"):
        if not line.strip():
            continue
        try:
            entry = json.loads(line)
        except json.JSONDecodeError:
            continue
        # Handle nested CC format: assistant messages contain tool_use in content array
        if entry.get("type") == "assistant":
            message = entry.get("message", {})
            for block in message.get("content", []):
                if block.get("type") == "tool_use":
                    tool_name = block.get("name", "")
                    source = "native" if tool_name in NATIVE_TOOLS else "shell"
                    results.append(
                        {"tool": tool_name, "args": block.get("input", {}), "source": source}
                    )
        # Also handle flat format (for test compatibility)
        elif entry.get("type") == "tool_use":
            tool_name = entry.get("name", "")
            source = "native" if tool_name in NATIVE_TOOLS else "shell"
            results.append({"tool": tool_name, "args": entry.get("input", {}), "source": source})
    return results


# Reverse mapping: Codex tool names → Claude Code canonical names.
# Only spawn_agent aliases to Agent (1:1 with a subagent launch). wait_agent
# and close_agent are the async-protocol join/teardown calls; aliasing them
# too would inflate tool-count Agent threefold and break the spec-aware
# codex-tool-mapping scenarios that grep for the raw codex names directly.
CODEX_TOOL_MAP: dict[str, str] = {
    "spawn_agent": "Agent",
}


def normalize_codex_logs(raw_content: str) -> list[dict[str, Any]]:
    """Normalize Codex rollout logs.

    Codex logs use: {"type": "response_item", "payload": {"type": "function_call", ...}}
    Tool calls are "function_call" with name "exec_command" (shell) or other names,
    plus "custom_tool_call" for patch-style edits.
    """
    results: list[dict[str, Any]] = []
    for line in raw_content.strip().split("\n"):
        if not line.strip():
            continue
        try:
            entry = json.loads(line)
        except json.JSONDecodeError:
            continue
        if entry.get("type") != "response_item":
            continue
        # Codex uses "payload" not "item"
        payload = entry.get("payload", entry.get("item", {}))
        payload_type = payload.get("type", "")
        if payload_type == "function_call":
            name = payload.get("name", "")
            raw_args = payload.get("arguments", "{}")
            # Arguments are JSON-encoded strings in codex
            if isinstance(raw_args, str):
                try:
                    args = json.loads(raw_args)
                except json.JSONDecodeError:
                    args = {"raw": raw_args}
            else:
                args = raw_args
            # exec_command is codex's shell tool
            if name == "exec_command":
                results.append(
                    {"tool": "Bash", "args": {"command": args.get("cmd", "")}, "source": "shell"}
                )
            elif name == "apply_patch":
                results.append({"tool": "Edit", "args": args, "source": "native"})
            else:
                canonical = CODEX_TOOL_MAP.get(name, name)
                source = "native" if canonical in NATIVE_TOOLS else "shell"
                results.append({"tool": canonical, "args": args, "source": source})
        elif payload_type == "custom_tool_call":
            name = payload.get("name", "")
            raw_input = payload.get("input", "")
            if name == "apply_patch":
                results.append({"tool": "Edit", "args": {"patch": raw_input}, "source": "native"})
            else:
                canonical = CODEX_TOOL_MAP.get(name, name)
                source = "native" if canonical in NATIVE_TOOLS else "shell"
                results.append(
                    {"tool": canonical, "args": {"input": raw_input}, "source": source}
                )
        elif payload_type == "local_shell_call":
            action = payload.get("action", {})
            cmd = action.get("command", [])
            cmd_str = " ".join(cmd) if isinstance(cmd, list) else str(cmd)
            results.append({"tool": "Bash", "args": {"command": cmd_str}, "source": "shell"})
    return results


# Reverse mapping: Pi tool names -> Claude Code canonical names
PI_TOOL_MAP: dict[str, str] = {
    "read": "Read",
    "write": "Write",
    "edit": "Edit",
    "bash": "Bash",
    "grep": "Grep",
    "find": "Glob",
    "ls": "Glob",
}


PI_NATIVE_TOOLS = (set(PI_TOOL_MAP.values()) - {"Bash"}) | {
    "subagent",
    "todo",
    "manage_todo_list",
}


def normalize_pi_logs(raw_content: str) -> list[dict[str, Any]]:
    """Normalize Pi JSONL session logs.

    Pi session files are JSONL entries. Assistant messages contain tool calls as
    content blocks: {"type": "toolCall", "name": "read", "arguments": {...}}.
    """
    results: list[dict[str, Any]] = []
    for line in raw_content.strip().split("\n"):
        if not line.strip():
            continue
        try:
            entry = json.loads(line)
        except json.JSONDecodeError:
            continue
        if entry.get("type") != "message":
            continue
        message = entry.get("message", {})
        if message.get("role") != "assistant":
            continue
        for block in message.get("content", []):
            if block.get("type") != "toolCall":
                continue
            name = block.get("name", "")
            canonical = PI_TOOL_MAP.get(name, name)
            source = "native" if canonical in PI_NATIVE_TOOLS else "shell"
            results.append(
                {"tool": canonical, "args": block.get("arguments", {}), "source": source}
            )
    return results


# Reverse mapping: Gemini tool names → Claude Code canonical names
GEMINI_TOOL_MAP: dict[str, str] = {
    "run_shell_command": "Bash",
    "read_file": "Read",
    "write_file": "Write",
    "replace": "Edit",
    "grep_search": "Grep",
    "glob": "Glob",
    "activate_skill": "Skill",
    "google_web_search": "WebSearch",
    "web_fetch": "WebFetch",
    "write_todos": "TodoWrite",
    "list_directory": "Glob",
    "enter_plan_mode": "EnterPlanMode",
    "exit_plan_mode": "ExitPlanMode",
}


def normalize_gemini_logs(raw_content: str) -> list[dict[str, Any]]:
    """Normalize Gemini CLI session logs.

    Gemini logs may be a single JSON file with a messages array, or JSONL
    session files in newer CLI versions. Each "gemini" message may have a
    toolCalls array:
    {"name": "run_shell_command", "args": {"command": "..."}, "status": "success"}
    """
    results: list[dict[str, Any]] = []
    messages: list[dict[str, Any]] = []
    try:
        data = json.loads(raw_content)
    except json.JSONDecodeError:
        for line in raw_content.strip().split("\n"):
            if not line.strip():
                continue
            try:
                entry = json.loads(line)
            except json.JSONDecodeError:
                continue
            if isinstance(entry, dict):
                messages.append(entry)
    else:
        if isinstance(data, dict) and "messages" in data:
            messages = [m for m in data.get("messages", []) if isinstance(m, dict)]
        elif isinstance(data, dict):
            messages = [data]
        elif isinstance(data, list):
            messages = [m for m in data if isinstance(m, dict)]

    seen_tool_calls: set[str] = set()
    for message in messages:
        if message.get("type") != "gemini":
            continue
        for tc in message.get("toolCalls", []):
            tool_call_id = tc.get("id")
            if tool_call_id and tool_call_id in seen_tool_calls:
                continue
            if tool_call_id:
                seen_tool_calls.add(tool_call_id)
            gemini_name = tc.get("name", "")
            canonical = GEMINI_TOOL_MAP.get(gemini_name, gemini_name)
            args = tc.get("args", {})
            source = "native" if canonical in NATIVE_TOOLS else "shell"
            results.append({"tool": canonical, "args": args, "source": source})
    return results


ANTIGRAVITY_TOOL_MAP: dict[str, str] = {
    "run_command": "Bash",
    "view_file": "Read",
    "write_to_file": "Write",
    "create_file": "Write",
    "replace_file_content": "Edit",
    "multi_replace_file_content": "Edit",
    "edit_file": "Edit",
    "grep_search": "Grep",
    "search_directory": "Grep",
    "list_dir": "Glob",
    "find_by_name": "Glob",
    "find_file": "Glob",
    "list_directory": "Glob",
    "invoke_subagent": "Agent",
    "search_web": "WebSearch",
    "read_url_content": "WebFetch",
}


ANTIGRAVITY_NATIVE_TOOLS = (set(ANTIGRAVITY_TOOL_MAP.values()) - {"Bash"}) | {
    "manage_task",
    "list_permissions",
}


_MISSING = object()


def _first_arg(args: dict[str, Any], keys: tuple[str, ...]) -> Any:
    for key in keys:
        if key in args:
            return args[key]
    return _MISSING


def _canonical_antigravity_tool_name(name: str) -> str:
    return ANTIGRAVITY_TOOL_MAP.get(name, name)


def _antigravity_tool_calls(entry: dict[str, Any]) -> list[dict[str, Any]]:
    containers = [entry]
    for planner_key in ("PLANNER_RESPONSE", "planner_response"):
        planner_response = entry.get(planner_key)
        if isinstance(planner_response, dict):
            containers.append(planner_response)

    calls: list[dict[str, Any]] = []
    for container in containers:
        for calls_key in ("tool_calls", "toolCalls"):
            tool_calls = container.get(calls_key)
            if not isinstance(tool_calls, list):
                continue
            calls.extend(call for call in tool_calls if isinstance(call, dict))
    return calls


def _normalize_antigravity_args(name: str, raw_args: Any) -> dict[str, Any]:
    if isinstance(raw_args, dict):
        original_args = dict(raw_args)
        args = dict(raw_args)
    else:
        original_args = raw_args
        args = {}

    args["raw_args"] = original_args

    if not isinstance(raw_args, dict):
        return args

    if name == "run_command":
        command = _first_arg(raw_args, ("CommandLine", "command"))
        if command is not _MISSING:
            args["command"] = command
    elif name == "view_file":
        file_path = _first_arg(
            raw_args, ("AbsolutePath", "Path", "path", "file_path", "filePath")
        )
        if file_path is not _MISSING:
            args["file_path"] = file_path

        is_skill_file = _first_arg(raw_args, ("IsSkillFile", "isSkillFile", "is_skill_file"))
        if is_skill_file is _MISSING:
            metadata = raw_args.get("metadata")
            if isinstance(metadata, dict):
                is_skill_file = _first_arg(
                    metadata, ("IsSkillFile", "isSkillFile", "is_skill_file")
                )
        if is_skill_file is not _MISSING:
            args["is_skill_file"] = is_skill_file
    elif name == "list_dir":
        path = _first_arg(raw_args, ("DirectoryPath", "directory_path", "path"))
        if path is not _MISSING:
            args["path"] = path

    return args


def normalize_antigravity_logs(raw_content: str) -> list[dict[str, Any]]:
    """Normalize Antigravity JSONL transcript tool calls.

    Antigravity emits tool calls in top-level tool_calls/toolCalls arrays and,
    for planner turns, nested under PLANNER_RESPONSE/planner_response.
    """
    results: list[dict[str, Any]] = []
    for line in raw_content.strip().split("\n"):
        if not line.strip():
            continue
        try:
            entry = json.loads(line)
        except json.JSONDecodeError:
            continue
        if not isinstance(entry, dict):
            continue

        for tool_call in _antigravity_tool_calls(entry):
            name = tool_call.get("name", "")
            if not isinstance(name, str) or not name:
                continue
            canonical = _canonical_antigravity_tool_name(name)
            args = _normalize_antigravity_args(name, tool_call.get("args", {}))
            source = "native" if canonical in ANTIGRAVITY_NATIVE_TOOLS else "shell"
            results.append({"tool": canonical, "args": args, "source": source})
    return results


NORMALIZERS: dict[str, Callable[[str], list[dict[str, Any]]]] = {
    "antigravity": normalize_antigravity_logs,
    "claude": normalize_claude_logs,
    "codex": normalize_codex_logs,
    "gemini": normalize_gemini_logs,
    "pi": normalize_pi_logs,
}
