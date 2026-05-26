# Superpowers Evals

Behavioral eval lab for superpowers. Python 3.11+, managed with uv.

The active runner is the Gauntlet-backed **Harness**. Drill is legacy and
slated for removal; do not write new scenarios against Drill.

## Canonical Actors

Keep the actors straight; confusing them is the most common triage error.
These names are used everywhere: docs, CLI output, code, filenames, and commit
messages.

| Actor | What it is | Where it lives / its files |
|---|---|---|
| **Gauntlet** | General-purpose QA framework; the `gauntlet` CLI. A black-box tester. | repo `~/Code/prime/gauntlet`; on `PATH` as `gauntlet` |
| **Gauntlet-Agent** | The LLM inside Gauntlet that drives the Coding-Agent and self-grades against the story's ACs. | model e.g. `claude-sonnet-4-6`; event stream -> `<run>/gauntlet-agent/results/<runId>/run.jsonl`; verdict -> `result.{json,md}` |
| **Coding-Agent** | The agent under test. Instances: **Claude**, **Codex**; future **Gemini**, **Pi**. | session log -> `<run>/coding-agent-config/...`; files it writes -> `<run>/coding-agent-workdir/` |
| **Harness** | The Python wrapper. Owns setup, Coding-Agent adaptation, deterministic checks, and final verdict composition. | repo `superpowers-evals/harness/`; `<run>/verdict.json` |

A run involves two LLMs: the **Gauntlet-Agent** (QA tester) and the
**Coding-Agent** (subject). Separate models, logs, and token costs.

## Commands

- **install**: `uv sync --extra dev`
- **test**: `uv run pytest`
- **test single**: `uv run pytest tests/harness/test_runner.py -x -q`
- **lint**: `uv run ruff check`
- **format**: `uv run ruff format`
- **typecheck**: `uv run ty check`
- **validate scenarios**: `uv run harness check`
- **run scenario**: `uv run harness run harness/scenarios/<name> --coding-agent <claude|codex>`
- **list scenarios**: `uv run harness list`
- **scaffold scenario**: `uv run harness new <name>`
- **show verdict**: `uv run harness show [<target>]`

## Architecture

**Harness (active):**

- `harness/runner.py` — per-run orchestration: setup, pre-checks, Gauntlet drive, capture, post-checks, verdict.
- `harness/checks.py` — sources `checks.sh`, runs `pre()`/`post()`, collects structured check records.
- `harness/composer.py` — composes Gauntlet-Agent verdict + deterministic checks into `pass | fail | indeterminate`.
- `harness/coding_agent_config.py` — per-Coding-Agent YAML loader and session-log config.
- `harness/capture.py` — session-log snapshot/diff, normalized tool-call capture, token capture.
- `harness/normalizers.py` — Coding-Agent session-log normalizers.
- `harness/scaffold.py` — `harness new` / `harness check` implementation.
- `harness/show.py` — verdict renderer for triage.
- `harness/bin/` — check-tool vocabulary; tools emit one JSON record each.
- `harness/scenarios/` — active scenarios, one directory each.
- `setup_helpers/*.py` — fixture creators shared by Harness and legacy Drill.

**Drill (legacy; frozen):**

- `drill/`, `backends/`, top-level `scenarios/`, top-level `bin/`, and
  `prompts/` remain for legacy-result archaeology and eventual decommissioning.
- Drill's sweep/compare ergonomics have not yet been replaced in the Harness;
  decide whether those are still needed before deleting Drill.

## Scenario Conventions

- A Harness scenario is `harness/scenarios/<name>/{story.md,setup.sh,checks.sh}`.
- `story.md` briefs the Gauntlet-Agent and includes evidence-demanding ACs.
- `setup.sh` builds the fixture using `$HARNESS_WORKDIR`; prefer
  `uv run setup-helpers run <helper>`.
- `checks.sh` contains only `pre()` and `post()` function definitions.
- `checks.sh` should not have the executable bit set.
- Check tools run from the fixture workdir with `harness/bin/` on `PATH`.
- Post-checks that need sibling run artifacts can use `$HARNESS_RUN_DIR`.
- Use `# coding-agents: <csv>` to restrict a scenario to specific agents.
- Use `requires-tool <name>` in `pre()` for local toolchain dependencies.

## Triage

Triaging a non-passing Harness run starts with:

```
uv run harness show [<target>]
```

Then use `docs/superpowers/skills/triaging-a-failing-eval.md` for the
attribution atlas.

## Safe Checks

These are safe for CI and routine PRs:

```
uv run ruff check
uv run ty check
uv run harness check
uv run pytest
```

Live `harness run ...` evals are trusted-maintainer operations only. They
launch agent CLIs in permissive modes and can capture sensitive transcripts,
tool calls, filesystem state, and token data. Do not add live evals, API keys,
or dangerous-mode launches to public CI.

## Required Env For Live Evals

```
ANTHROPIC_API_KEY=sk-...
OPENAI_API_KEY=sk-...
```

When this repo is checked out as `superpowers/evals`, the Harness defaults
`SUPERPOWERS_ROOT` to the parent `superpowers` checkout. In a standalone
`superpowers-evals` clone, export it explicitly:

```
export SUPERPOWERS_ROOT=/path/to/superpowers
```

## Parent Superpowers Submodule

`superpowers-evals` is consumed by `superpowers` as the `evals` submodule.
After any PR merges to `main` here, open a follow-up PR against the parent
`superpowers` repo targeting `dev` that bumps the `evals` submodule pointer to
the merged `superpowers-evals` commit.

Do not treat a `superpowers-evals` merge as fully propagated until that parent
submodule bump PR exists.
