#!/usr/bin/env python3
"""Does writing-skills still produce well-formed skills after a change?

When to use: after changing skills/writing-skills, especially moving its
guidance between SKILL.md and references/. Each rep asks a headless
`claude -p` session, with the whole superpowers plugin under test loaded, to
write one new skill from baseline results that are already in hand. Then it
checks the SKILL.md the agent wrote.

Scenarios:

  discovery       a shaping failure (bloated changelog entries). Checks the
                  frontmatter: a "Use when..." description, no workflow
                  summary, under 500 characters.
  bulletproofing  a discipline failure with verbatim rationalizations.
                  Checks for a rationalization table that uses them and a
                  red-flags list.

Each rep runs in a fresh fixture copy under an isolated HOME (no user
instructions, no installed plugins) with a private copy of the plugin, so
nothing it does can write into the checkout under test.

Auth: CLAUDE_CODE_OAUTH_TOKEN or ANTHROPIC_API_KEY from the environment,
falling back to this repo's .env.

Output: one line per rep with the checks and the writing-skills files the
agent read. Per rep, summary.md holds the written SKILL.md. Read every one;
the checks are heuristics.

Examples:
  quick-evals/writing-skills/write-a-skill.py --plugin-dir /tmp/superpowers-v7.0.0
  quick-evals/writing-skills/write-a-skill.py --scenario bulletproofing --reps 5
"""

import argparse
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
FIXTURES = Path(__file__).resolve().parent / "fixtures"
PROMPTS = {
    "discovery": (
        "Use superpowers:writing-skills to write a new skill, skills/writing-changelog-entries/SKILL.md, "
        "that fixes how agents write CHANGELOG entries. I already ran the baseline scenarios: the results "
        "are in baseline-results.md. Write the skill now; I'll run the GREEN scenarios myself afterwards."
    ),
    "bulletproofing": (
        "Use superpowers:writing-skills to write a new skill, skills/full-suite-before-done/SKILL.md, that "
        "makes agents run the full test suite before they claim a fix is done. I already ran the baseline "
        "pressure scenarios: the results are in baseline-results.md. Write the skill now; I'll run the "
        "GREEN scenarios myself afterwards."
    ),
}
SKILL_PATHS = {
    "discovery": "skills/writing-changelog-entries/SKILL.md",
    "bulletproofing": "skills/full-suite-before-done/SKILL.md",
}
RATIONALIZATIONS = ["one line", "covers this function", "CI will", "four minutes", "after I report"]
# Ignore the evals tree and local state when copying the plugin, as the evals' staging does.
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


def frontmatter_description(text: str) -> str:
    match = re.search(r"^---\n(.*?)\n---", text, re.S)
    if not match:
        return ""
    desc = re.search(r"^description:\s*(.*)$", match.group(1), re.M)
    return desc.group(1).strip().strip("'\"") if desc else ""


def check(scenario: str, skill: str) -> dict:
    desc = frontmatter_description(skill)
    result = {
        "written": bool(skill),
        "use_when": desc.lower().startswith("use when"),
        "desc_chars": len(desc),
        # A workflow summary in the description reads as a sequence of steps.
        "workflow_in_desc": bool(re.search(r"\b(then|first|step|steps|by (writing|running|listing))\b", desc, re.I)),
    }
    if scenario == "bulletproofing":
        table_rows = [line for line in skill.splitlines() if line.startswith("|")]
        result["rationalizations_in_table"] = sum(
            any(r.lower() in row.lower() for row in table_rows) for r in RATIONALIZATIONS)
        result["red_flags"] = bool(re.search(r"^#+ .*red flags", skill, re.I | re.M))
    return result


def skill_reads(stream: Path, plugin: Path) -> list[str]:
    """Which writing-skills files the agent read.

    Path-agnostic on purpose: agents reach references through absolute paths,
    relative ones, and shell variables (`P=.../references; cat $P/x.md`).
    """
    reads = []
    refs_dir = plugin / "skills" / "writing-skills" / "references"
    known = {p.name for p in refs_dir.iterdir()} if refs_dir.is_dir() else set()
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
            text = json.dumps(block.get("input", {}))
            if block.get("name") == "Skill" and "writing-skills" in text:
                reads.append("SKILL.md")
            if "writing-skills/references" in text:
                reads += ["references/" + name for name in re.findall(r"([\w-]+\.(?:md|dot))", text)
                          if name in known]
    return sorted(set(reads))


def run_rep(scenario: str, rep: int, args, auth_env: dict, out_root: Path) -> str:
    rep_dir = out_root / scenario / f"rep-{rep}"
    rep_dir.mkdir(parents=True)
    project = rep_dir / "project"
    shutil.copytree(FIXTURES / scenario, project)
    git = ["git", "-c", "user.name=Test", "-c", "user.email=test@example.com"]
    subprocess.run(["git", "init", "-q", "-b", "main"], cwd=project, check=True)
    subprocess.run(["git", "add", "-A"], cwd=project, check=True)
    subprocess.run(git + ["commit", "-q", "-m", "Baseline results"], cwd=project, check=True)
    plugin = rep_dir / "plugin"
    shutil.copytree(args.plugin_dir, plugin, ignore=PLUGIN_IGNORE)
    home = Path(tempfile.mkdtemp(prefix="ws-home-"))
    env = {k: v for k, v in os.environ.items() if k not in ("CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_API_KEY")}
    env.update(auth_env, HOME=str(home))
    stream = rep_dir / "stream.jsonl"
    with stream.open("w") as fh:
        proc = subprocess.run(
            ["claude", "-p", PROMPTS[scenario], "--plugin-dir", str(plugin), "--model", args.model,
             "--output-format", "stream-json", "--verbose", "--dangerously-skip-permissions",
             "--max-turns", str(args.max_turns)],
            cwd=project, env=env, stdin=subprocess.DEVNULL, stdout=fh, stderr=subprocess.STDOUT,
            timeout=args.timeout,
        )
    shutil.rmtree(home, ignore_errors=True)
    skill_file = project / SKILL_PATHS[scenario]
    skill = skill_file.read_text() if skill_file.exists() else ""
    result = check(scenario, skill)
    reads = skill_reads(stream, plugin)
    (rep_dir / "summary.md").write_text(
        f"# {scenario} rep {rep}\n\nexit {proc.returncode}\n\nchecks: {json.dumps(result)}\n\n"
        f"read: {', '.join(reads) or '-'}\n\n## {SKILL_PATHS[scenario]}\n\n{skill or '(not written)'}\n")
    flags = " ".join(f"{k}={v}" for k, v in result.items())
    return f"{scenario:14} rep {rep}  {flags}  read: {', '.join(reads) or '-'}"


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--scenario", choices=sorted(PROMPTS) + ["all"], default="all")
    parser.add_argument("--reps", type=int, default=3)
    parser.add_argument("--plugin-dir", type=Path, default=Path(os.environ.get("SUPERPOWERS_ROOT") or EVALS.parent),
                        help="superpowers checkout under test (default: $SUPERPOWERS_ROOT, else the parent checkout)")
    parser.add_argument("--model", default="claude-opus-5-5")
    parser.add_argument("--max-turns", type=int, default=30)
    parser.add_argument("--timeout", type=int, default=900)
    parser.add_argument("--jobs", type=int, default=3)
    parser.add_argument("--label", default="")
    args = parser.parse_args()
    args.plugin_dir = args.plugin_dir.resolve()
    if not (args.plugin_dir / "skills" / "writing-skills" / "SKILL.md").is_file():
        sys.exit(f"error: {args.plugin_dir} is not a superpowers checkout")
    auth_env = load_auth_env()
    scenarios = sorted(PROMPTS) if args.scenario == "all" else [args.scenario]
    name = f"{time.strftime('%Y%m%d-%H%M%S')}-{args.model}" + (f"-{args.label}" if args.label else "")
    out_root = Path(tempfile.gettempdir()) / "writing-skills-quick-eval" / name
    out_root.mkdir(parents=True)
    print(f"plugin: {args.plugin_dir}\nresults: {out_root}", flush=True)
    jobs = [(s, r) for s in scenarios for r in range(1, args.reps + 1)]
    with ThreadPoolExecutor(max_workers=args.jobs) as pool:
        futures = [pool.submit(run_rep, s, r, args, auth_env, out_root) for s, r in jobs]
        for future in futures:
            try:
                print(future.result(), flush=True)
            except Exception as exc:  # report and keep the other reps going
                print(f"rep failed: {exc}", flush=True)


if __name__ == "__main__":
    main()
