#!/usr/bin/env python3
"""Does an SDD controller stop at the fix-round cap after a compaction?

When to use: after changing skills/subagent-driven-development, to check
that the five-round cap and the breaker still hold once Claude Code has
compacted the session (obra/superpowers#2481). Cheap: one headless
`claude -p` turn per rep.

The setup mimics what a controller holds right after a compaction: a
compaction summary that no longer mentions the cap, and the skill
re-attached the way Claude Code does it, under "Base directory for this
skill:". Arms choose what that re-attached text is:

  truncated  SKILL.md cut at 20,000 characters plus Claude Code's marker
  full       the whole SKILL.md

The fixture is a plan whose Task 3 has just finished fix round 5/5 with one
finding still open, in a real git history on a feature branch. The ledger's
round lines carry no "/5", so the cap has to come from the skill. A
controller that follows the skill trips the breaker:
it adjudicates the finding and writes a parked/Ruling line to the ledger.
A controller that lost the rule dispatches round 6.

Each rep runs in a fresh fixture copy under an isolated HOME, with no
plugins loaded; the skill directory is only reachable through the base
directory path, so reading references/ or the full SKILL.md is visible in
the log.

Auth: CLAUDE_CODE_OAUTH_TOKEN or ANTHROPIC_API_KEY from the environment,
falling back to this repo's .env.

Output: one line per rep with the outcome, the skill files it read, and
the path to its summary.md. Read every summary; the outcome is a heuristic.

Examples:
  quick-evals/sdd/compaction-breaker.py --skill-dir /tmp/superpowers-v7.0.0/skills/subagent-driven-development --arm truncated
  quick-evals/sdd/compaction-breaker.py --arm full --reps 5
"""

import argparse
import json
import re
import os
import shutil
import subprocess
import sys
import tempfile
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

EVALS = Path(__file__).resolve().parents[2]
FIXTURE = Path(__file__).resolve().parent / "fixtures" / "breaker-after-compaction"
CUT = 20000
PLAN = "docs/superpowers/plans/2026-10-15-notify-plan.md"
WORKSPACE = "2026-10-15-notify-plan"
MARKER = "\n\n[... skill content truncated for compaction; use Read on the skill path if you need the full text]"
PROMPT = (
    "This session is being continued from a previous conversation that ran out of context. "
    "Summary: you are the controller running superpowers:subagent-driven-development on "
    "docs/superpowers/plans/2026-10-15-notify-plan.md. The plan's workspace is "
    ".superpowers/sdd/2026-10-15-notify-plan/ and its ledger is progress.md there. Tasks 1 and 2 are "
    "complete. Task 3 is in its fix loop on the 'wrap breaks mid-word' finding. The scoped "
    "re-review you just dispatched has come back: .superpowers/sdd/2026-10-15-notify-plan/task-3-rereview-5.md. "
    "Continue from where you left off."
)


def load_auth_env() -> dict:
    env = {k: os.environ[k] for k in ("CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_API_KEY") if os.environ.get(k)}
    if env:
        return env
    dotenv = EVALS / ".env"
    if dotenv.exists():
        for line in dotenv.read_text().splitlines():
            key, sep, value = line.partition("=")
            if sep and key.strip() in ("CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_API_KEY"):
                env[key.strip()] = value.strip().strip("'\"")
    if not env:
        sys.exit(f"error: set CLAUDE_CODE_OAUTH_TOKEN or ANTHROPIC_API_KEY, or put one in {dotenv}")
    return env


def reattached_skill(skill_dir: Path, arm: str) -> str:
    text = (skill_dir / "SKILL.md").read_text()
    if arm == "truncated" and len(text) > CUT:
        text = text[:CUT] + MARKER
    return (
        "The following skill was invoked earlier in this session and is re-attached after compaction.\n\n"
        f"Base directory for this skill: {skill_dir}\n\n{text}"
    )


# Ledger rounds for Task 3, oldest first. The count carries no "/5": the
# cap has to come from the skill, as it did in obra/superpowers#2481.
ROUNDS = [
    "1 addressed, 2 open — subject ignores tz; wrap breaks mid-word",
    "0 addressed, 2 open — subject ignores tz; wrap breaks mid-word",
    "1 addressed, 1 open — wrap breaks mid-word",
    "0 addressed, 1 open — wrap breaks mid-word",
    "0 addressed, 1 open — wrap breaks mid-word",
]


def make_project(dest: Path) -> None:
    """Copy the fixture and build the git history and ledger it describes."""
    shutil.copytree(FIXTURE, dest)
    (dest / "dot-gitignore").rename(dest / ".gitignore")
    workspace = dest / ".superpowers" / "sdd"
    workspace.mkdir(parents=True)
    # Named and marked the way scripts/sdd-workspace names and marks it.
    (dest / "sdd-workspace").rename(workspace / WORKSPACE)
    (workspace / WORKSPACE / "plan-path").write_text(PLAN + "\n")
    git = ["git", "-c", "user.name=Test", "-c", "user.email=test@example.com"]

    def commit(message: str) -> str:
        # Each commit touches the file the tasks work on, so the history isn't empty.
        with (dest / "src" / "digest.py").open("a") as fh:
            fh.write(f"# {message}\n")
        subprocess.run(["git", "add", "-A"], cwd=dest, check=True)
        subprocess.run(git + ["commit", "-q", "-m", message], cwd=dest, check=True)
        return subprocess.run(["git", "rev-parse", "--short=7", "HEAD"], cwd=dest, check=True,
                              capture_output=True, text=True).stdout.strip()

    subprocess.run(["git", "init", "-q", "-b", "main"], cwd=dest, check=True)
    subprocess.run(["git", "add", "-A"], cwd=dest, check=True)
    base = commit("Add notification digest plan and scaffolding")
    subprocess.run(["git", "switch", "-q", "-c", "feature/notify-digest"], cwd=dest, check=True)
    t1 = commit("Task 1: Digest dataclass")
    t2 = commit("Task 2: format_item")
    ledger = [
        f"# SDD ledger — plan: {PLAN}",
        "Preflight: scan clean (4 tasks, no shared-interface conflicts)",
        f"Task 1: complete (commits {base}..{t1}, review clean)",
        f"Task 2: complete (commits {t1}..{t2}, review clean)",
    ]
    prev = commit("Task 3: render digest")
    for n, summary in enumerate(ROUNDS, start=1):
        head = commit(f"Task 3: fix round {n}")
        ledger.append(f"Task 3: fix round {n} ({summary}; commits {prev}..{head})")
        prev = head
    (workspace / WORKSPACE / "progress.md").write_text("\n".join(ledger) + "\n")


def classify(stream: Path, skill_dir: Path) -> tuple[str, list[str], list[str]]:
    """Return (outcome, skill files read, tool lines) from the stream log.

    ROUND6: before Task 3's finding was parked, it got another fix dispatch or
    a "fix round 6" ledger line.
    BREAKER: Task 3's open finding was parked or ruled on in the ledger first.
    Later dispatches (Task 4, the final review and its fix wave) are correct.
    """
    reads, tools = [], []
    round6 = parked = False
    for line in stream.read_text().splitlines():
        try:
            event = json.loads(line)
        except json.JSONDecodeError:
            continue
        if event.get("type") != "assistant":
            continue
        for block in event.get("message", {}).get("content", []):
            if block.get("type") != "tool_use":
                continue
            name, args = block.get("name", ""), block.get("input", {})
            detail = str(args.get("file_path") or args.get("command") or args.get("description") or "")
            tools.append(f"{name} {detail[:120]}")
            text = json.dumps(args)
            # A read names the skill dir, either in the path or in a `cd` before
            # a relative `cat references/...`.
            if str(skill_dir) in text:
                reads += re.findall(r"(?<![\w/.-])(?:" + re.escape(str(skill_dir)) + r"/)?(SKILL\.md|references/[\w-]+\.md)", text)
            if name in ("Agent", "Task") and not parked:
                prompt = str(args.get("prompt", "")) + str(args.get("description", ""))
                if "Task 3" in prompt and "Task 4" not in prompt and "fix" in prompt.lower():
                    round6 = True
            if "progress.md" in text and name in ("Write", "Edit", "Bash"):
                if "fix round 6" in text and not parked:
                    round6 = True
                if "Task 3: parked" in text or ("Task 3" in text and "Ruling" in text) or "breaker" in text:
                    parked = True
    outcome = "ROUND6" if round6 else "BREAKER" if parked else "OTHER"
    return outcome, sorted(set(reads)), tools


def run_rep(rep: int, args, auth_env: dict, out_root: Path) -> str:
    rep_dir = out_root / f"rep-{rep}"
    rep_dir.mkdir(parents=True)
    project = rep_dir / "project"
    make_project(project)
    # A private copy of the skill: controllers run its scripts, which must not
    # write into the checkout under test.
    skill_dir = rep_dir / "skill" / args.skill_dir.name
    shutil.copytree(args.skill_dir, skill_dir)
    home = Path(tempfile.mkdtemp(prefix="sdd-cb-home-"))
    env = {k: v for k, v in os.environ.items() if k not in ("CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_API_KEY")}
    env.update(auth_env, HOME=str(home))
    stream = rep_dir / "stream.jsonl"
    with stream.open("w") as fh:
        proc = subprocess.run(
            ["claude", "-p", PROMPT, "--model", args.model, "--append-system-prompt",
             reattached_skill(skill_dir, args.arm), "--output-format", "stream-json", "--verbose",
             "--dangerously-skip-permissions", "--max-turns", str(args.max_turns)],
            cwd=project, env=env, stdin=subprocess.DEVNULL, stdout=fh, stderr=subprocess.STDOUT,
            timeout=args.timeout,
        )
    shutil.rmtree(home, ignore_errors=True)
    outcome, reads, tools = classify(stream, skill_dir)
    ledger_path = project / ".superpowers" / "sdd" / WORKSPACE / "progress.md"
    ledger = ledger_path.read_text() if ledger_path.exists() else "(ledger missing at the end of the run)"
    (rep_dir / "summary.md").write_text(
        f"# rep {rep}: {outcome}\n\nexit {proc.returncode}\n\n## tool calls\n"
        + "".join(f"- {t}\n" for t in tools) + f"\n## ledger after\n\n{ledger}\n"
    )
    return f"rep {rep:2}  {outcome:10}  read: {', '.join(reads) or '-'}  ({rep_dir}/summary.md)"


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    default_skill = Path(os.environ.get("SUPERPOWERS_ROOT") or EVALS.parent) / "skills" / "subagent-driven-development"
    parser.add_argument("--skill-dir", type=Path, default=default_skill,
                        help="skills/subagent-driven-development under test (default: from $SUPERPOWERS_ROOT or the parent checkout)")
    parser.add_argument("--arm", choices=["truncated", "full"], required=True)
    parser.add_argument("--reps", type=int, default=5)
    parser.add_argument("--model", default="claude-opus-5-5")
    parser.add_argument("--max-turns", type=int, default=8)
    parser.add_argument("--timeout", type=int, default=600)
    parser.add_argument("--jobs", type=int, default=5)
    parser.add_argument("--label", default="")
    args = parser.parse_args()
    args.skill_dir = args.skill_dir.resolve()
    if not (args.skill_dir / "SKILL.md").is_file():
        sys.exit(f"error: no SKILL.md in {args.skill_dir}")
    auth_env = load_auth_env()
    name = f"{time.strftime('%Y%m%d-%H%M%S')}-{args.model}-{args.arm}" + (f"-{args.label}" if args.label else "")
    out_root = Path(tempfile.gettempdir()) / "sdd-compaction-breaker" / name
    out_root.mkdir(parents=True)
    print(f"skill: {args.skill_dir} ({args.arm})\nresults: {out_root}", flush=True)
    with ThreadPoolExecutor(max_workers=args.jobs) as pool:
        futures = [pool.submit(run_rep, r, args, auth_env, out_root) for r in range(1, args.reps + 1)]
        for future in futures:
            try:
                print(future.result(), flush=True)
            except Exception as exc:  # report and keep the other reps going
                print(f"rep failed: {exc}", flush=True)


if __name__ == "__main__":
    main()
