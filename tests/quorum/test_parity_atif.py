"""Cutover-gate parity: OLD shell-tools pipeline vs NEW check-transcript pipeline.

For each coding agent we hold a SINGLE rich agent-native session-log fixture and
run every check verb against it through BOTH pipelines, asserting an identical
verdict (passed flag + pass/fail exit) for every (agent, verb, case).

OLD pipeline (Python normalizer + bin/<verb> shell tool):
    raw fixture
      -> quorum.normalizers.normalize_<agent>_logs(raw)            # list[dict]
      -> write flat coding-agent-tool-calls.jsonl (one dict/line)
      -> bin/<verb> <args>  with QUORUM_TOOL_CALLS_PATH + QUORUM_RECORD_SINK
      -> read record.passed + process exit code

NEW pipeline (TS normalizer + check-transcript CLI):
    raw fixture
      -> bun run ts/src/cli/normalize.ts <agent> <fixture> --version test
      -> write trajectory.json
      -> bun run ts/src/cli/check-transcript.ts <verb> <args>
             with QUORUM_TRANSCRIPT_PATH + QUORUM_RECORD_SINK
      -> read record.passed + process exit code

The fixtures normalize through BOTH normalizers to equivalent {tool, args}
streams, so any normalizer divergence that would change a verdict surfaces
here as a parity failure (which is exactly the cutover blocker we want to see).

The curated case list deliberately mixes expected-PASS and expected-FAIL
outcomes; `test_suite_is_not_trivially_all_pass` proves every verb is
exercised in BOTH polarities somewhere across the suite. For tool-arg-match
the OLD side uses the jq filter and the NEW side uses the structured matcher
flags — same logical assertion, proving the migration mapping is
verdict-equivalent.
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
from collections.abc import Callable
from dataclasses import dataclass, field
from pathlib import Path

import pytest

from quorum import normalizers

REPO = Path(__file__).resolve().parents[2]
BIN = REPO / "bin"
TS_NORMALIZE = REPO / "ts" / "src" / "cli" / "normalize.ts"
TS_CHECK = REPO / "ts" / "src" / "cli" / "check-transcript.ts"

WORKDIR_PREFIX = "/run/coding-agent-workdir"

requires_bun = pytest.mark.skipif(shutil.which("bun") is None, reason="bun not installed")
requires_jq = pytest.mark.skipif(shutil.which("jq") is None, reason="jq not installed")


# ---------------------------------------------------------------------------
# Agent-native fixtures
#
# Each fixture contains, in this order, the same logical event sequence:
#   1. Skill load: superpowers:brainstorming  (native Skill tool where the
#      agent has one, else a Bash `cat .../skills/superpowers/brainstorming/
#      SKILL.md`).
#   2. Bash investigation: `grep -r foo .`     (investigated PASS).
#   3. Bash worktree create: `git worktree add ../wt feature`.
#   4. Implementation Write under /run/coding-agent-workdir/src/app.py.
# These cover skill-*, investigated, worktree-created, implementation-*,
# tool-*, and tool-arg-match in one stream.
# ---------------------------------------------------------------------------

IMPL_PATH = f"{WORKDIR_PREFIX}/src/app.py"
SKILL_MD = "skills/superpowers/brainstorming/SKILL.md"


def _claude_fixture() -> str:
    lines = [
        {
            "type": "assistant",
            "message": {
                "role": "assistant",
                "content": [
                    {
                        "type": "tool_use",
                        "id": "t1",
                        "name": "Skill",
                        "input": {"skill": "superpowers:brainstorming"},
                    }
                ],
            },
        },
        {
            "type": "assistant",
            "message": {
                "role": "assistant",
                "content": [
                    {
                        "type": "tool_use",
                        "id": "t2",
                        "name": "Bash",
                        "input": {"command": "grep -r foo ."},
                    }
                ],
            },
        },
        {
            "type": "assistant",
            "message": {
                "role": "assistant",
                "content": [
                    {
                        "type": "tool_use",
                        "id": "t3",
                        "name": "Bash",
                        "input": {"command": "git worktree add ../wt feature"},
                    }
                ],
            },
        },
        {
            "type": "assistant",
            "message": {
                "role": "assistant",
                "content": [
                    {
                        "type": "tool_use",
                        "id": "t4",
                        "name": "Write",
                        "input": {"file_path": IMPL_PATH, "content": "x"},
                    }
                ],
            },
        },
    ]
    return "\n".join(json.dumps(line) for line in lines)


def _codex_fixture() -> str:
    # Codex has no native Skill; it loads skills via the shell.
    lines = [
        {
            "type": "response_item",
            "payload": {
                "type": "function_call",
                "name": "exec_command",
                "arguments": json.dumps({"cmd": f"cat {SKILL_MD}"}),
                "call_id": "c1",
            },
        },
        {
            "type": "response_item",
            "payload": {
                "type": "function_call",
                "name": "exec_command",
                "arguments": json.dumps({"cmd": "grep -r foo ."}),
                "call_id": "c2",
            },
        },
        {
            "type": "response_item",
            "payload": {
                "type": "function_call",
                "name": "exec_command",
                "arguments": json.dumps({"cmd": "git worktree add ../wt feature"}),
                "call_id": "c3",
            },
        },
        {
            "type": "response_item",
            "payload": {
                "type": "function_call",
                "name": "apply_patch",
                "arguments": json.dumps({"file_path": IMPL_PATH, "patch": "x"}),
                "call_id": "c4",
            },
        },
    ]
    return "\n".join(json.dumps(line) for line in lines)


def _gemini_fixture() -> str:
    lines = [
        {
            "type": "gemini",
            "toolCalls": [
                {
                    "id": "g1",
                    "name": "activate_skill",
                    "args": {"skill": "superpowers:brainstorming"},
                }
            ],
        },
        {
            "type": "gemini",
            "toolCalls": [
                {"id": "g2", "name": "run_shell_command", "args": {"command": "grep -r foo ."}}
            ],
        },
        {
            "type": "gemini",
            "toolCalls": [
                {
                    "id": "g3",
                    "name": "run_shell_command",
                    "args": {"command": "git worktree add ../wt feature"},
                }
            ],
        },
        {
            "type": "gemini",
            "toolCalls": [{"id": "g4", "name": "write_file", "args": {"file_path": IMPL_PATH}}],
        },
    ]
    return "\n".join(json.dumps(line) for line in lines)


def _copilot_fixture() -> str:
    lines = [
        {
            "type": "assistant.message",
            "data": {
                "toolRequests": [
                    {"name": "skill", "arguments": {"skill": "superpowers:brainstorming"}}
                ]
            },
        },
        {
            "type": "assistant.message",
            "data": {"toolRequests": [{"name": "bash", "arguments": {"cmd": "grep -r foo ."}}]},
        },
        {
            "type": "assistant.message",
            "data": {
                "toolRequests": [
                    {"name": "bash", "arguments": {"cmd": "git worktree add ../wt feature"}}
                ]
            },
        },
        {
            "type": "assistant.message",
            "data": {"toolRequests": [{"name": "write", "arguments": {"file_path": IMPL_PATH}}]},
        },
    ]
    return "\n".join(json.dumps(line) for line in lines)


def _opencode_fixture() -> str:
    export = {
        "messages": [
            {
                "parts": [
                    {
                        "type": "tool",
                        "tool": "skill",
                        "state": {"input": {"skill": "superpowers:brainstorming"}},
                    },
                    {
                        "type": "tool",
                        "tool": "bash",
                        "state": {"input": {"command": "grep -r foo ."}},
                    },
                    {
                        "type": "tool",
                        "tool": "bash",
                        "state": {"input": {"command": "git worktree add ../wt feature"}},
                    },
                    {
                        "type": "tool",
                        "tool": "write",
                        "state": {"input": {"file_path": IMPL_PATH, "content": "x"}},
                    },
                ]
            }
        ]
    }
    return json.dumps(export)


def _pi_fixture() -> str:
    # Pi has no native Skill; skill load via Bash cat of SKILL.md.
    lines = [
        {
            "type": "message",
            "message": {
                "role": "assistant",
                "content": [
                    {
                        "type": "toolCall",
                        "name": "bash",
                        "arguments": {"command": f"cat {SKILL_MD}"},
                    }
                ],
            },
        },
        {
            "type": "message",
            "message": {
                "role": "assistant",
                "content": [
                    {"type": "toolCall", "name": "bash", "arguments": {"command": "grep -r foo ."}}
                ],
            },
        },
        {
            "type": "message",
            "message": {
                "role": "assistant",
                "content": [
                    {
                        "type": "toolCall",
                        "name": "bash",
                        "arguments": {"command": "git worktree add ../wt feature"},
                    }
                ],
            },
        },
        {
            "type": "message",
            "message": {
                "role": "assistant",
                "content": [
                    {"type": "toolCall", "name": "write", "arguments": {"file_path": IMPL_PATH}}
                ],
            },
        },
    ]
    return "\n".join(json.dumps(line) for line in lines)


@dataclass(frozen=True)
class Agent:
    name: str  # normalizer name (python normalize_<name>_logs and ts normalize.ts key)
    fixture: Callable[[], str]
    # The canonical tool the agent's file-write normalizes to. Codex writes via
    # apply_patch, which normalizes to Edit; every other agent's write
    # normalizes to Write. Cases that reference the implementation tool
    # substitute {IMPL} with this so the implementation-* and Write-arg cases
    # exercise a REAL (non-vacuous) outcome on every agent — see
    # Case.resolve(). Pi/Codex load skills via the shell (cat SKILL.md) rather
    # than a native Skill tool; the skill-* verbs still match because the
    # predicate recognizes the shell-read form.
    impl_tool: str = "Write"


AGENTS: list[Agent] = [
    Agent("claude", _claude_fixture),
    Agent("codex", _codex_fixture, impl_tool="Edit"),
    Agent("gemini", _gemini_fixture),
    Agent("copilot", _copilot_fixture),
    Agent("opencode", _opencode_fixture),
    Agent("pi", _pi_fixture),
]


# ---------------------------------------------------------------------------
# Curated verb cases. Each maps the OLD args (shell-tool argv) to the NEW args
# (check-transcript argv). For all verbs except tool-arg-match the two argv
# lists are identical. The polarity column documents the INTENDED outcome for
# the canonical fixtures (used by the not-trivially-all-pass guard); the parity
# assertion itself never trusts this column — it compares OLD vs NEW directly.
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class Case:
    verb: str
    old_args: list[str]
    new_args: list[str] = field(default_factory=list)
    polarity: str = "pass"  # "pass" | "fail"  (intended, documentation only)

    def _sub(self, args: list[str], impl_tool: str) -> list[str]:
        return [a.replace("{IMPL}", impl_tool) for a in args]

    def resolved_old_args(self, agent: Agent) -> list[str]:
        return self._sub(self.old_args, agent.impl_tool)

    def resolved_new_args(self, agent: Agent) -> list[str]:
        base = self.new_args if self.new_args else self.old_args
        return self._sub(base, agent.impl_tool)


CASES: list[Case] = [
    # tool-called
    Case("tool-called", ["Bash"], polarity="pass"),
    Case("tool-called", ["NoSuchTool"], polarity="fail"),
    # tool-not-called
    Case("tool-not-called", ["NoSuchTool"], polarity="pass"),
    Case("tool-not-called", ["Bash"], polarity="fail"),
    # tool-count
    Case("tool-count", ["Bash", "gte", "2"], polarity="pass"),
    Case("tool-count", ["Bash", "eq", "0"], polarity="fail"),
    # tool-before  ({IMPL} = Write, or Edit for codex)
    Case("tool-before", ["Bash", "{IMPL}"], polarity="pass"),
    Case("tool-before", ["{IMPL}", "Bash"], polarity="fail"),
    # skill-called
    Case("skill-called", ["superpowers:brainstorming"], polarity="pass"),
    Case("skill-called", ["superpowers:nonexistent"], polarity="fail"),
    # skill-not-called
    Case("skill-not-called", ["superpowers:nonexistent"], polarity="pass"),
    Case("skill-not-called", ["superpowers:brainstorming"], polarity="fail"),
    # skill-before-tool
    Case("skill-before-tool", ["superpowers:brainstorming", "{IMPL}"], polarity="pass"),
    # vacuous pass — gated tool never fires:
    Case("skill-before-tool", ["superpowers:brainstorming", "NoSuchTool"], polarity="pass"),
    # fail — tool fires but skill never did:
    Case("skill-before-tool", ["superpowers:nonexistent", "{IMPL}"], polarity="fail"),
    # skill-before-implementation-tool
    Case(
        "skill-before-implementation-tool",
        ["superpowers:brainstorming", "{IMPL}"],
        polarity="pass",
    ),
    Case(
        "skill-before-implementation-tool",
        ["superpowers:nonexistent", "{IMPL}"],
        polarity="fail",
    ),
    # implementation-tool-not-called
    Case("implementation-tool-not-called", ["Read"], polarity="pass"),
    Case("implementation-tool-not-called", ["{IMPL}"], polarity="fail"),
    # investigated (no args)
    Case("investigated", [], polarity="pass"),
    # tool-match-before-tool-match
    Case(
        "tool-match-before-tool-match",
        ["Bash", "grep", "Bash", "git[[:space:]]+worktree"],
        polarity="pass",
    ),
    Case(
        "tool-match-before-tool-match",
        ["Bash", "git[[:space:]]+worktree", "Bash", "grep"],
        polarity="fail",
    ),
    # worktree-created (no args)
    Case("worktree-created", [], polarity="pass"),
    # tool-arg-match — OLD jq filter, NEW structured matchers
    Case(
        "tool-arg-match",
        old_args=["Bash", '.command | test("git[[:space:]]+worktree[[:space:]]+add")'],
        new_args=["Bash", "--matches", "command=git[[:space:]]+worktree[[:space:]]+add"],
        polarity="pass",
    ),
    Case(
        "tool-arg-match",
        old_args=["Bash", '.command | test("this-never-appears")'],
        new_args=["Bash", "--matches", "command=this-never-appears"],
        polarity="fail",
    ),
    Case(
        "tool-arg-match",
        old_args=["{IMPL}", '(.file_path // .path // "") | test("(^|/)app[.]py$")'],
        new_args=["{IMPL}", "--matches", "file_path,path=(^|/)app[.]py$"],
        polarity="pass",
    ),
]


# ---------------------------------------------------------------------------
# Pipeline runners
# ---------------------------------------------------------------------------


def _run_old(agent: Agent, verb: str, args: list[str], tmp_path: Path) -> tuple[bool, int]:
    raw = agent.fixture()
    records = getattr(normalizers, f"normalize_{agent.name}_logs")(raw)
    calls_path = tmp_path / "coding-agent-tool-calls.jsonl"
    calls_path.write_text("".join(json.dumps(r) + "\n" for r in records))

    sink = tmp_path / "old-sink.jsonl"
    env = {
        **os.environ,
        "QUORUM_TOOL_CALLS_PATH": str(calls_path),
        "QUORUM_RECORD_SINK": str(sink),
    }
    proc = subprocess.run(
        [str(BIN / verb), *args],
        env=env,
        capture_output=True,
        text=True,
        cwd=str(tmp_path),
    )
    passed = _last_record_passed(sink)
    return passed, proc.returncode


def _run_new(agent: Agent, verb: str, args: list[str], tmp_path: Path) -> tuple[bool, int]:
    fixture_path = tmp_path / f"{agent.name}-fixture"
    fixture_path.write_text(agent.fixture())

    norm = subprocess.run(
        ["bun", "run", str(TS_NORMALIZE), agent.name, str(fixture_path), "--version", "test"],
        capture_output=True,
        text=True,
        cwd=str(REPO),
    )
    assert norm.returncode == 0, f"normalize failed: {norm.stderr}"
    traj_path = tmp_path / "trajectory.json"
    traj_path.write_text(norm.stdout)

    sink = tmp_path / "new-sink.jsonl"
    env = {
        **os.environ,
        "QUORUM_TRANSCRIPT_PATH": str(traj_path),
        "QUORUM_RECORD_SINK": str(sink),
    }
    proc = subprocess.run(
        ["bun", "run", str(TS_CHECK), verb, *args],
        env=env,
        capture_output=True,
        text=True,
        cwd=str(REPO),
    )
    passed = _last_record_passed(sink)
    return passed, proc.returncode


def _last_record_passed(sink: Path) -> bool:
    if not sink.exists():
        raise AssertionError(f"no record sink written at {sink}")
    lines = [ln for ln in sink.read_text().splitlines() if ln.strip()]
    if not lines:
        raise AssertionError(f"record sink empty at {sink}")
    return bool(json.loads(lines[-1])["passed"])


# ---------------------------------------------------------------------------
# The parity test
# ---------------------------------------------------------------------------


def _case_id(agent: Agent, case: Case) -> str:
    new_suffix = "" if case.new_args == [] or case.new_args == case.old_args else "→new"
    args = case.resolved_old_args(agent)
    return f"{agent.name}-{case.verb}-{case.polarity}-{'_'.join(args) or 'noargs'}{new_suffix}"


PARAMS = [pytest.param(agent, case, id=_case_id(agent, case)) for agent in AGENTS for case in CASES]


@requires_bun
@requires_jq
@pytest.mark.parametrize("agent,case", PARAMS)
def test_old_new_verdict_parity(agent: Agent, case: Case, tmp_path: Path) -> None:
    old_dir = tmp_path / "old"
    new_dir = tmp_path / "new"
    old_dir.mkdir()
    new_dir.mkdir()

    old_args = case.resolved_old_args(agent)
    new_args = case.resolved_new_args(agent)

    old_passed, old_exit = _run_old(agent, case.verb, old_args, old_dir)
    new_passed, new_exit = _run_new(agent, case.verb, new_args, new_dir)

    assert old_passed == new_passed, (
        f"VERDICT DIVERGENCE [{agent.name}/{case.verb} {old_args}]: "
        f"OLD passed={old_passed} NEW passed={new_passed}"
    )
    assert (old_exit == 0) == (new_exit == 0), (
        f"EXIT DIVERGENCE [{agent.name}/{case.verb} {old_args}]: "
        f"OLD exit={old_exit} NEW exit={new_exit}"
    )


# ---------------------------------------------------------------------------
# Coverage guards — the suite must exercise every verb in BOTH polarities and
# must not be trivially all-pass.
# ---------------------------------------------------------------------------

ALL_VERBS = {
    "tool-called",
    "tool-not-called",
    "tool-count",
    "tool-before",
    "skill-called",
    "skill-not-called",
    "skill-before-tool",
    "skill-before-implementation-tool",
    "implementation-tool-not-called",
    "investigated",
    "worktree-created",
    "tool-match-before-tool-match",
    "tool-arg-match",
}


def test_all_twelve_plus_verbs_covered() -> None:
    covered = {c.verb for c in CASES}
    missing = ALL_VERBS - covered
    assert not missing, f"verbs with no parity case: {sorted(missing)}"


def test_suite_is_not_trivially_all_pass() -> None:
    """Every verb must appear with at least one intended-PASS AND one intended-FAIL
    case somewhere in the suite — except investigated/worktree-created, which take
    no args and have only a positive form on these fixtures. Those two are still
    exercised; we assert the suite overall carries both polarities."""
    no_fail_form = {"investigated", "worktree-created"}
    pass_verbs = {c.verb for c in CASES if c.polarity == "pass"}
    fail_verbs = {c.verb for c in CASES if c.polarity == "fail"}

    # Global: the suite is not all-pass.
    assert fail_verbs, "suite has no intended-FAIL cases — trivially all-pass"
    assert pass_verbs, "suite has no intended-PASS cases"

    for verb in ALL_VERBS - no_fail_form:
        assert verb in pass_verbs, f"{verb} has no intended-PASS case"
        assert verb in fail_verbs, f"{verb} has no intended-FAIL case"


@requires_bun
@requires_jq
def test_fixtures_realize_both_polarities(tmp_path: Path) -> None:
    """Sanity: on the claude fixture, at least one case actually fails and at
    least one passes through the OLD pipeline. Guards against a fixture that
    accidentally makes every assertion vacuously pass."""
    agent = AGENTS[0]
    results = []
    for i, case in enumerate(CASES):
        d = tmp_path / f"c{i}"
        d.mkdir()
        passed, _ = _run_old(agent, case.verb, case.resolved_old_args(agent), d)
        results.append(passed)
    assert any(results), "no case passed on claude fixture"
    assert not all(results), "every case passed on claude fixture — not exercising FAIL paths"
