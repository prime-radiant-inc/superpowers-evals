#!/usr/bin/env python3
"""Run a tiny two-task plan through executing-plans and check how it ends.

When to use: after changing skills/executing-plans. Each rep asks a headless
`claude -p` session, with the plugin under test (a private copy) loaded, to
execute a two-task plan inline. Task 2 consumes `make_slug` while Task 1
produces `slugify`, so a correct run rules on the mismatch.

Checks, from the final repo, ledger and final message:

  tests        the suite passes at the end
  complete     the ledger has a completion line for both tasks
  ruling       the ledger has a Ruling: line about the make_slug mismatch
  reviewed     a final whole-branch reviewer was dispatched
  rulings_list the final message lists "Rulings I made" with that ruling
  minors_list  if the ledger defers minors, the final message lists
               "Deferred minors" (n/a when there are none)

Each rep runs in a fresh fixture copy on a feature branch under an isolated
HOME (no user instructions, no installed plugins).

Auth: CLAUDE_CODE_OAUTH_TOKEN or ANTHROPIC_API_KEY from the environment,
falling back to this repo's .env.

Output: one line per rep. Per rep, summary.md holds the ledger and final
message. Read every one; the checks are heuristics.

Examples:
  quick-evals/executing-plans/inline-run.py --plugin-dir /tmp/superpowers-v7.0.0
  quick-evals/executing-plans/inline-run.py --reps 5
"""

import argparse
import glob
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

EVALS = Path(__file__).resolve().parents[2]
FIXTURE = Path(__file__).resolve().parent / "fixtures" / "two-task-plan"
PLAN = "docs/superpowers/plans/2026-10-19-slugify-plan.md"
PROMPT = (
    f"Execute {PLAN} inline in this session with superpowers:executing-plans. "
    "We're already on a feature branch for this work, so no new worktree is needed."
)
PLUGIN_IGNORE = shutil.ignore_patterns(".git", "node_modules", "evals", ".claude", ".worktrees", ".superpowers", "__pycache__")


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


def make_project(dest: Path) -> None:
    shutil.copytree(FIXTURE, dest)
    (dest / "dot-gitignore").rename(dest / ".gitignore")
    git = ["git", "-c", "user.name=Test", "-c", "user.email=test@example.com"]
    subprocess.run(["git", "init", "-q", "-b", "main"], cwd=dest, check=True)
    subprocess.run(["git", "add", "-A"], cwd=dest, check=True)
    subprocess.run(git + ["commit", "-q", "-m", "Add slugify plan"], cwd=dest, check=True)
    subprocess.run(["git", "switch", "-q", "-c", "feature/slugify"], cwd=dest, check=True)
    subprocess.run(["git", "config", "user.name", "Test"], cwd=dest, check=True)
    subprocess.run(["git", "config", "user.email", "test@example.com"], cwd=dest, check=True)


def final_message_and_dispatches(stream: Path) -> tuple[str, int]:
    final, dispatches = "", 0
    for line in stream.read_text().splitlines():
        try:
            event = json.loads(line)
        except json.JSONDecodeError:
            continue
        if event.get("type") == "result":
            final = event.get("result", "") or final
        if event.get("type") == "assistant":
            for block in event.get("message", {}).get("content", []):
                if block.get("type") == "tool_use" and block.get("name") in ("Agent", "Task"):
                    dispatches += 1
    return final, dispatches


def find_ledger(project: Path, stream: Path) -> str:
    """The workspace may already be deleted at the end; fall back to what was written."""
    found = glob.glob(str(project / ".superpowers" / "sdd" / "*" / "progress.md"))
    if found:
        return Path(found[0]).read_text()
    written = []
    for line in stream.read_text().splitlines():
        if "progress.md" in line and ("Task " in line or "Ruling" in line or "minor" in line):
            written.append(line)
    return "\n".join(written)


def run_rep(rep: int, args, auth_env: dict, out_root: Path) -> str:
    rep_dir = out_root / f"rep-{rep}"
    rep_dir.mkdir(parents=True)
    project = rep_dir / "project"
    make_project(project)
    plugin = rep_dir / "plugin"
    shutil.copytree(args.plugin_dir, plugin, ignore=PLUGIN_IGNORE)
    home = Path(tempfile.mkdtemp(prefix="ep-home-"))
    env = {k: v for k, v in os.environ.items() if k not in ("CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_API_KEY")}
    env.update(auth_env, HOME=str(home))
    stream = rep_dir / "stream.jsonl"
    with stream.open("w") as fh:
        proc = subprocess.run(
            ["claude", "-p", PROMPT, "--plugin-dir", str(plugin), "--model", args.model,
             "--output-format", "stream-json", "--verbose", "--dangerously-skip-permissions",
             "--max-turns", str(args.max_turns)],
            cwd=project, env=env, stdin=subprocess.DEVNULL, stdout=fh, stderr=subprocess.STDOUT,
            timeout=args.timeout,
        )
    shutil.rmtree(home, ignore_errors=True)
    final, dispatches = final_message_and_dispatches(stream)
    ledger = find_ledger(project, stream)
    log = stream.read_text()
    tests = subprocess.run(["python3", "-m", "unittest", "-q"], cwd=project, capture_output=True, text=True)
    has_minors = "minor (deferred)" in ledger
    checks = {
        "tests": tests.returncode == 0,
        # Match task-done's real line; the skill text itself can contain sample ledger lines.
        "complete": all(re.search(rf"Task {n}: complete \(commits [0-9a-f]+\.\.[0-9a-f]+, tests: python3", log)
                        for n in (1, 2)),
        "ruling": bool(re.search(r"Ruling:.*(make_slug|slugify)", ledger)),
        "reviewed": dispatches > 0,
        "rulings_list": bool(re.search(r"rulings i made", final, re.I)) and ("make_slug" in final or "slugify" in final),
        "minors_list": (bool(re.search(r"deferred minors", final, re.I)) if has_minors else "n/a"),
    }
    (rep_dir / "summary.md").write_text(
        f"# rep {rep}\n\nexit {proc.returncode}\n\nchecks: {json.dumps(checks)}\n\n## ledger\n\n{ledger}\n\n"
        f"## final message\n\n{final}\n")
    return f"rep {rep:2}  " + " ".join(f"{k}={v}" for k, v in checks.items())


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--reps", type=int, default=3)
    parser.add_argument("--plugin-dir", type=Path, default=Path(os.environ.get("SUPERPOWERS_ROOT") or EVALS.parent),
                        help="superpowers checkout under test (default: $SUPERPOWERS_ROOT, else the parent checkout)")
    parser.add_argument("--model", default="claude-opus-5-5")
    parser.add_argument("--max-turns", type=int, default=80)
    parser.add_argument("--timeout", type=int, default=1500)
    parser.add_argument("--jobs", type=int, default=3)
    parser.add_argument("--label", default="")
    args = parser.parse_args()
    args.plugin_dir = args.plugin_dir.resolve()
    if not (args.plugin_dir / "skills" / "executing-plans" / "SKILL.md").is_file():
        sys.exit(f"error: {args.plugin_dir} is not a superpowers checkout")
    auth_env = load_auth_env()
    name = f"{time.strftime('%Y%m%d-%H%M%S')}-{args.model}" + (f"-{args.label}" if args.label else "")
    out_root = Path(tempfile.gettempdir()) / "executing-plans-inline-run" / name
    out_root.mkdir(parents=True)
    print(f"plugin: {args.plugin_dir}\nresults: {out_root}", flush=True)
    with ThreadPoolExecutor(max_workers=args.jobs) as pool:
        futures = [pool.submit(run_rep, r, args, auth_env, out_root) for r in range(1, args.reps + 1)]
        for future in futures:
            try:
                print(future.result(), flush=True)
            except Exception as exc:  # report and keep the other reps going
                print(f"rep failed: {exc}", flush=True)


if __name__ == "__main__":
    main()
