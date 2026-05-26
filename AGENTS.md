# Superpowers Evals

Behavioral eval lab for superpowers. Python 3.11+, managed with uv.

The active runner is the Gauntlet-backed **Harness**. Drill is legacy and
slated for removal; do not write new scenarios against Drill.

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

- `harness/runner.py` — per-run orchestration: setup, pre-checks, Gauntlet drive, capture, post-checks, verdict.
- `harness/checks.py` — sources `checks.sh`, runs `pre()`/`post()`, collects structured check records.
- `harness/composer.py` — composes Gauntlet-Agent verdict + deterministic checks into `pass | fail | indeterminate`.
- `harness/coding_agent_config.py` — per-Coding-Agent YAML loader and session-log config.
- `harness/capture.py` — session-log snapshot/diff, normalized tool-call capture, token capture.
- `harness/normalizers.py` — Coding-Agent session-log normalizers.
- `harness/scaffold.py` — `harness new` / `harness check` implementation.
- `harness/show.py` — verdict renderer for triage.
- `harness/bin/` — check-tool vocabulary; tools emit one JSON record each.
- `harness/coding-agents/*.yaml` — per-Coding-Agent CLI config.
- `harness/coding-agent-contexts/*/HOWTO.md` — instructions copied into Gauntlet-Agent context.
- `harness/scenarios/*/` — active scenarios, one directory each.
- `setup_helpers/*.py` — fixture creators shared by Harness and legacy Drill.
- `fixtures/` — static fixture repos and agent-config skeletons.

Legacy Drill code remains in `drill/`, `backends/`, top-level `scenarios/`,
top-level `bin/`, and `prompts/`. Keep those frozen unless a task is explicitly
about Drill decommissioning or legacy-result archaeology.

## Scenario Conventions

- A Harness scenario is a directory under `harness/scenarios/<name>/`.
- Required files: `story.md`, `setup.sh`, `checks.sh`.
- `story.md` briefs the Gauntlet-Agent and includes acceptance criteria.
- `setup.sh` builds the fixture using `$HARNESS_WORKDIR`; prefer
  `uv run setup-helpers run <helper>` over inline Python.
- `checks.sh` contains exactly `pre()` and `post()` function definitions and no
  top-level executable statements.
- `checks.sh` should not have the executable bit set.
- Check tools run from the fixture workdir with `harness/bin/` on `PATH`.
- Post-checks that need sibling run artifacts can use `$HARNESS_RUN_DIR`.
- Use the top-of-file `# coding-agents: <csv>` directive to restrict a scenario
  to specific Coding-Agents.
- Use `requires-tool <name>` in `pre()` when a scenario depends on a local
  toolchain such as `go` or `npm`.

## Verdict Model

Harness verdicts are three-valued:

- `pass` — Gauntlet-Agent passed and all post-checks passed.
- `fail` — Gauntlet-Agent failed or a post-check failed.
- `indeterminate` — setup/pre-check/capture/harness failure, Gauntlet
  `investigate`, or empty trace when trace checks are present.

Triaging a non-passing Harness run starts with `uv run harness show [<target>]`
and `docs/superpowers/skills/triaging-a-failing-eval.md`.

## Safety

Static/unit checks are safe for CI:

```
uv run ruff check
uv run ty check
uv run harness check
uv run pytest
```

Live evals are trusted-maintainer operations only. They launch agent CLIs in
permissive modes and can capture sensitive transcripts, tool calls, filesystem
state, and token data. Do not add live `harness run ...` invocations, API keys,
or dangerous-mode agent launches to public CI.

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
