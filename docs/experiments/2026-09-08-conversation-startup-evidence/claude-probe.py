#!/usr/bin/env python3
"""Run one Claude startup case inside the pinned, network-disabled eval image."""

from __future__ import annotations

import argparse
import hashlib
import http.server
import json
import os
import re
import signal
import subprocess
import threading
import time
from pathlib import Path
from typing import Any

IMAGE = "sha256:01fb1cd08f1e31c82fccedbaadead09e6ff97bca1f5d66f2f0904728ad536e8c"
ROOT = Path("/probe")
REQUEST_LIMIT = 4
CASE_DEADLINE = 25.0
PROMPT = "Reply with exactly PROBE_OK and do not use tools."

PROVISION_TS = r"""
import { join } from 'node:path';
import { loadAgentConfigForValidation } from '/workspace/evals/src/contracts/agent-config.ts';
import { loadCredentialsFile } from '/workspace/evals/src/credentials/file.ts';
import { resolveAgent, CLAUDE_ENV_FILE_NAME, shellSingleQuote } from '/workspace/evals/src/agents/index.ts';
import { buildContextSubstitutions } from '/workspace/evals/src/runner/index.ts';
import { populateContextDir } from '/workspace/evals/src/runner/context.ts';
const r = JSON.parse(process.env.PROBE_REQUEST!);
const cfg = loadAgentConfigForValidation('/workspace/evals/coding-agents', 'claude');
const credentialName = r.kind === 'mantle' ? 'opus5_bedrock' : 'opus5';
const credential = loadCredentialsFile('/workspace/evals/credentials.yaml').credentials[credentialName]!;
const home = { configDir: r.configDir, workdir: r.workdir, skeletonRoot: undefined, superpowers: { mode: 'root', root: '/workspace/superpowers' } };
resolveAgent(cfg).provision(home, undefined as never, credential as never);
const launcher = join(r.runDir, 'gauntlet-agent', 'context', 'launch-agent');
const substitutions = buildContextSubstitutions({ launchCwd: r.workdir, launchAgentPath: launcher, runHomeDir: r.home, family: 'claude', superpowers: home.superpowers });
const envFile = join(r.configDir, CLAUDE_ENV_FILE_NAME);
substitutions['$CLAUDE_ENV_FILE'] = envFile;
substitutions['$CLAUDE_ENV_FILE_SH'] = shellSingleQuote(envFile);
substitutions['$CLAUDE_MODEL'] = credential.model;
populateContextDir({ codingAgentsDir: '/workspace/evals/coding-agents', codingAgent: 'claude', runDir: r.runDir, substitutions, required: true, forbiddenPlaceholders: ['$CLAUDE_ENV_FILE', '$CLAUDE_MODEL', '$QUORUM_AGENT_CWD', '$QUORUM_AGENT_HOME', '$QUORUM_HOME_ENV', '$SUPERPOWERS_PLUGIN_ARGS'] });
console.log(JSON.stringify({ launcher, credentialName, credential: { model: credential.model, api: credential.api, auth: credential.auth, api_key_env: credential.api_key_env, region: credential.region, harnesses: credential.harnesses } }));
"""


def run(argv: list[str], timeout: float = 10, check: bool = True) -> str:
    result = subprocess.run(
        argv, capture_output=True, text=True, timeout=timeout, check=check
    )
    return result.stdout


def digest(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def save(path: Path, value: Any) -> None:
    path.write_text(json.dumps(value, indent=2, sort_keys=True) + "\n")


class Provider(http.server.ThreadingHTTPServer):
    def __init__(self) -> None:
        self.requests: list[dict[str, Any]] = []
        self.exceeded = False
        super().__init__(("127.0.0.1", 0), Handler)


class Handler(http.server.BaseHTTPRequestHandler):
    server: Provider

    def log_message(self, *_args: Any) -> None:
        pass

    def do_POST(self) -> None:
        body = self.rfile.read(int(self.headers.get("content-length", "0")))
        try:
            request = json.loads(body)
        except json.JSONDecodeError:
            request = {}
        self.server.requests.append(
            {
                "number": len(self.server.requests) + 1,
                "path": self.path,
                "body_sha256": hashlib.sha256(body).hexdigest(),
                "bytes": len(body),
                "model": request.get("model"),
                "stream": request.get("stream"),
                "api_key_header_present": bool(self.headers.get("x-api-key")),
            }
        )
        if len(self.server.requests) > REQUEST_LIMIT:
            self.server.exceeded = True
            self.send_error(429)
            return
        if self.path.split("?", 1)[0] != "/v1/messages":
            self.send_error(404)
            return
        model = request.get("model", "claude-probe")
        events = [
            ("message_start", {"type": "message_start", "message": {"id": "msg_probe", "type": "message", "role": "assistant", "model": model, "content": [], "stop_reason": None, "stop_sequence": None, "usage": {"input_tokens": 11, "output_tokens": 0, "cache_creation_input_tokens": 0, "cache_read_input_tokens": 0}}}),
            ("content_block_start", {"type": "content_block_start", "index": 0, "content_block": {"type": "text", "text": ""}}),
            ("content_block_delta", {"type": "content_block_delta", "index": 0, "delta": {"type": "text_delta", "text": "PROBE_OK"}}),
            ("content_block_stop", {"type": "content_block_stop", "index": 0}),
            ("message_delta", {"type": "message_delta", "delta": {"stop_reason": "end_turn", "stop_sequence": None}, "usage": {"output_tokens": 3}}),
            ("message_stop", {"type": "message_stop"}),
        ]
        payload = "".join(
            f"event: {event}\ndata: {json.dumps(data, separators=(',', ':'))}\n\n"
            for event, data in events
        ).encode()
        self.send_response(200)
        self.send_header("content-type", "text/event-stream")
        self.send_header("content-length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)


def provision(kind: str, provider_url: str | None) -> tuple[Path, Path]:
    home, config_dir, workdir, run_dir = (
        ROOT / "home",
        ROOT / "home/.claude",
        ROOT / "work",
        ROOT / "run",
    )
    for path in (config_dir, workdir, run_dir):
        path.mkdir(parents=True, exist_ok=True)
    driver = ROOT / "provision.ts"
    driver.write_text(PROVISION_TS)
    request = json.dumps(
        {
            "kind": kind,
            "home": str(home),
            "configDir": str(config_dir),
            "workdir": str(workdir),
            "runDir": str(run_dir),
        }
    )
    env = dict(
        os.environ,
        PROBE_REQUEST=request,
        ANTHROPIC_API_KEY="sk-ant-api03-probe-dummy-only",
        AWS_BEARER_TOKEN_BEDROCK="probe-dummy-bearer",
    )
    output = subprocess.run(
        ["bun", "run", str(driver)],
        capture_output=True,
        text=True,
        timeout=20,
        check=True,
        env=env,
    ).stdout
    generated = json.loads(output.strip().splitlines()[-1])
    launcher = Path(generated["launcher"])
    nested_path = config_dir / ".claude.json"
    top_level_path = home / ".claude.json"
    before = {
        "nested_sha256": digest(nested_path),
        "top_level_sha256": digest(top_level_path),
        "nested_approved_count": len(json.loads(nested_path.read_text()).get("customApiKeyResponses", {}).get("approved", [])),
        "top_level_approved_count": len(json.loads(top_level_path.read_text()).get("customApiKeyResponses", {}).get("approved", [])),
    }
    config = json.loads(nested_path.read_text())
    config["hasCompletedOnboarding"] = True
    for path in (nested_path, top_level_path):
        save(path, config)
    after = {
        "nested_sha256": digest(nested_path),
        "top_level_sha256": digest(top_level_path),
        "approved_count": len(config.get("customApiKeyResponses", {}).get("approved", [])),
    }
    env_names = [
        line.split("=", 1)[0]
        for line in (config_dir / ".claude-env").read_text().splitlines()
        if "=" in line
    ]
    save(ROOT / "config-receipt.json", {"credential_name": generated["credentialName"], "credential": generated["credential"], "env_file_names": env_names, "before_mirror": before, "after_mirror_and_onboarding": after})
    settings_path = config_dir / "settings.json"
    settings = json.loads(settings_path.read_text()) if settings_path.exists() else {}
    settings["skipDangerousModePermissionPrompt"] = True
    if provider_url:
        settings["env"] = {
            **settings.get("env", {}),
            "ANTHROPIC_BASE_URL": provider_url,
        }
    save(settings_path, settings)
    return launcher, home


def capture(socket: Path) -> str:
    value = run(
        ["tmux", "-S", str(socket), "capture-pane", "-p", "-J", "-S", "-60", "-t", "subject"],
        2,
    )
    value = value.replace(str(ROOT), "/probe")
    return re.sub(r"sk-ant-[A-Za-z0-9_-]+", "[redacted-dummy-key]", value).rstrip()


def classify(value: str) -> tuple[str, str | None]:
    failures = {
        "theme_menu": ["Choose the text style", "Choose your preferred theme"],
        "security_menu": ["Security notes", "Trust this folder"],
        "bypass_menu": ["Yes, I accept", "Bypass Permissions mode"],
        "login_menu": ["Select login method", "Log in to your account"],
        "auth_error": ["Not logged in", "Invalid API key"],
    }
    for name, markers in failures.items():
        if any(marker.lower() in value.lower() for marker in markers):
            return "failure", name
    if "Claude Code v" in value and re.search(r"(?m)^❯\s*$", value) and "bypass permissions on" in value.lower():
        return "ready", "Claude Code header + standalone `❯` + `bypass permissions on` footer"
    return "waiting", None


def session_receipt(home: Path) -> dict[str, Any]:
    evidence = []
    for path in sorted((home / ".claude/projects").glob("**/*.jsonl")):
        text = path.read_text(errors="replace")
        nonzero_usage = False
        for line in text.splitlines():
            try:
                usage = json.loads(line).get("message", {}).get("usage", {})
                nonzero_usage |= any(
                    isinstance(value, (int, float)) and value > 0
                    for value in usage.values()
                )
            except (json.JSONDecodeError, AttributeError):
                pass
        evidence.append(
            {
                "path": str(path.relative_to(home)),
                "sha256": digest(path),
                "bytes": path.stat().st_size,
                "response_present": "PROBE_OK" in text,
                "nonzero_usage": nonzero_usage,
            }
        )
    return {
        "count": len(evidence),
        "files": evidence,
        "response_present": any(item["response_present"] for item in evidence),
        "nonzero_usage": any(item["nonzero_usage"] for item in evidence),
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("case", choices=["direct", "direct-delayed", "mantle"])
    args = parser.parse_args()
    started = time.monotonic()
    version = run(["claude", "--version"], 5).strip()
    if version != "2.1.209 (Claude Code)":
        raise RuntimeError(f"unexpected Claude version: {version}")

    provider = Provider()
    provider_thread = threading.Thread(target=provider.serve_forever, daemon=True)
    provider_thread.start()
    kind = "mantle" if args.case == "mantle" else "direct"
    provider_url = None if kind == "mantle" else f"http://127.0.0.1:{provider.server_port}"
    launcher, home = provision(kind, provider_url)
    launcher_hash = digest(launcher)
    launcher_text = launcher.read_text()
    socket = ROOT / "tmux.sock"
    wrapper = ROOT / "start.sh"
    delay = 2 if args.case == "direct-delayed" else 0
    wrapper.write_text(f"#!/bin/sh\nsleep {delay}\nexec '{launcher}'\n")
    wrapper.chmod(0o755)
    launch_started = time.monotonic()
    captures: list[dict[str, Any]] = []
    failure = signature = None
    ready_at = None
    response_visible = False
    pane_pid = None
    pane_dead_status = None
    input_events: list[dict[str, Any]] = []
    native: dict[str, Any] = {"count": 0, "files": [], "response_present": False, "nonzero_usage": False}
    try:
        tmux_config = ROOT / "tmux.conf"
        tmux_config.write_text("set-option -g remain-on-exit on\n")
        run(["tmux", "-S", str(socket), "-f", str(tmux_config), "new-session", "-d", "-x", "120", "-y", "40", "-s", "subject", str(wrapper)], 3)
        pane_pid = int(run(["tmux", "-S", str(socket), "display-message", "-p", "-t", "subject", "#{pane_pid}"], 2).strip())
        deadline, previous = launch_started + CASE_DEADLINE, None
        while time.monotonic() < deadline:
            current = capture(socket)
            if current != previous:
                captures.append({"elapsed_seconds": round(time.monotonic() - launch_started, 3), "screen": current})
                previous = current
            dead = run(["tmux", "-S", str(socket), "display-message", "-p", "-t", "subject", "#{pane_dead}:#{pane_dead_status}"], 2).strip()
            if dead.startswith("1:"):
                pane_dead_status = dead.split(":", 1)[1]
                failure = f"subject_exited_status_{pane_dead_status}"
                break
            state, detail = classify(current)
            if state == "failure":
                failure = detail
                break
            if state == "ready":
                signature, ready_at = detail, round(time.monotonic() - launch_started, 3)
                break
            time.sleep(0.1)
        if not signature and not failure:
            failure = "readiness_timeout"
        if signature and args.case == "direct":
            input_events.append({"elapsed_seconds": round(time.monotonic() - launch_started, 3), "after_ready": True})
            prompt = ROOT / "prompt.txt"
            prompt.write_text(PROMPT)
            run(["tmux", "-S", str(socket), "load-buffer", "-b", "probe", str(prompt)], 2)
            run(["tmux", "-S", str(socket), "paste-buffer", "-b", "probe", "-t", "subject"], 2)
            run(["tmux", "-S", str(socket), "send-keys", "-t", "subject", "Enter"], 2)
            response_deadline = min(deadline, time.monotonic() + 12)
            while time.monotonic() < response_deadline:
                current = capture(socket)
                if current != previous:
                    captures.append({"elapsed_seconds": round(time.monotonic() - launch_started, 3), "screen": current})
                    previous = current
                if "PROBE_OK" in current:
                    response_visible = True
                    break
                time.sleep(0.1)
            if not response_visible:
                failure = "response_timeout"
        time.sleep(0.3)
        native = session_receipt(home)
    finally:
        subprocess.run(["tmux", "-S", str(socket), "send-keys", "-t", "subject", "C-c"], capture_output=True, timeout=2)
        time.sleep(0.2)
        subprocess.run(["tmux", "-S", str(socket), "kill-server"], capture_output=True, timeout=2)
        provider.shutdown()
        provider.server_close()
        provider_thread.join(2)
        if pane_pid and Path(f"/proc/{pane_pid}").exists():
            os.kill(pane_pid, signal.SIGKILL)
            time.sleep(0.1)

    config_dir = home / ".claude"
    direct_ok = response_visible and native["response_present"] and native["nonzero_usage"]
    success = bool(signature) and not failure and not provider.exceeded
    if args.case == "direct":
        success = success and direct_ok and len(provider.requests) >= 1
    else:
        success = success and len(provider.requests) == 0
    if args.case == "direct-delayed":
        success = success and ready_at is not None and ready_at >= delay
    receipt = {
        "success": success,
        "case": args.case,
        "image": IMAGE,
        "external_network": "docker --network none (caller)",
        "real_credentials": False,
        "cli_version": version,
        "evals_sha": run(["git", "-c", "safe.directory=/workspace/evals", "-C", "/workspace/evals", "rev-parse", "HEAD"]).strip(),
        "superpowers_sha": run(["git", "-c", "safe.directory=/workspace/superpowers", "-C", "/workspace/superpowers", "rev-parse", "HEAD"]).strip(),
        "launcher_sha256": launcher_hash,
        "plugin_arg_present": "--plugin-dir" in launcher_text and "/workspace/superpowers" in launcher_text,
        "onboarding_mirrors": [json.loads((config_dir / ".claude.json").read_text())["hasCompletedOnboarding"], json.loads((home / ".claude.json").read_text())["hasCompletedOnboarding"]],
        "skip_bypass_prompt": json.loads((config_dir / "settings.json").read_text())["skipDangerousModePermissionPrompt"],
        "settings_env_base_url": kind == "direct",
        "config_mirror": json.loads((ROOT / "config-receipt.json").read_text()),
        "composer_signature": signature,
        "ready_elapsed_seconds": ready_at,
        "response_visible": response_visible,
        "failure": failure,
        "provider_request_limit": REQUEST_LIMIT,
        "input_events_before_ready": sum(not event["after_ready"] for event in input_events),
        "input_events": input_events,
        "provider_requests": provider.requests,
        "native_session": native,
        "captures": captures,
        "pane_dead_status": pane_dead_status,
        "cleanup": {"pane_pid": pane_pid, "pane_absent": not (pane_pid and Path(f'/proc/{pane_pid}').exists()), "tmux_socket_exists": socket.exists()},
        "elapsed_seconds": round(time.monotonic() - started, 3),
    }
    save(ROOT / "receipt.json", receipt)
    print(json.dumps({"success": success, "receipt_sha256": digest(ROOT / "receipt.json")}, indent=2))
    return 0 if success else 1


if __name__ == "__main__":
    raise SystemExit(main())
