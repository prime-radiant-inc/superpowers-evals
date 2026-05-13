# Drill

Drill is the behavioral eval harness for
[superpowers](https://github.com/obra/superpowers). It drives real coding-agent
CLIs through tmux sessions and checks whether they invoke and follow
superpowers skills correctly.

This is not a generic benchmark suite. Drill is an eval lab for workflow
compliance: skill triggering, worktree behavior, subagent coordination,
verification reflexes, review quality, and cost-shaping patterns.

## Safety Model

Drill has two very different execution modes:

- **Static/unit checks** are safe for public CI. These run `ruff`, `ty`, and
  `pytest`. They do not call model APIs and do not launch agent CLIs.
- **Live evals** are trusted-maintainer operations. They can launch Claude
  Code, Codex CLI, or Gemini CLI in permissive modes and may collect raw
  transcripts, tool calls, filesystem state, and local session logs.

Public CI must stay on the static/unit side of that line. Do not add API keys,
live `drill run ...` sweeps, or dangerous-mode agent launches to public CI.

## Live Eval Risk

Live evals intentionally run the backend under test with broad execution power:

- Claude backends use `--dangerously-skip-permissions`
- Codex uses `--dangerously-bypass-approvals-and-sandbox`
- Gemini uses `--yolo`

Those subprocesses can currently inherit the parent shell environment and may
use the caller's normal home-directory config/log locations. In practice, that
means a live eval can see exported credentials, local agent configuration, and
other process environment state unless the runner starts it from a deliberately
clean shell.

Until per-run environment isolation is implemented, run live evals only from a
trusted local environment:

- Export only the API key needed for the selected backend.
- Avoid running with broad production or personal secrets in the environment.
- Treat `results/`, raw session logs, and verifier inputs as sensitive.
- Do not commit or paste raw run artifacts without checking them first.

## How Drill Works

1. **Setup** creates a temporary git repo with scenario-specific conditions.
2. **Actor** uses Sonnet to simulate a realistic user from the scenario turns.
3. **Agent** runs the backend under test in a tmux session.
4. **Collection** captures terminal output, filesystem state, and tool calls.
5. **Verifier** uses Sonnet to judge the transcript against semantic criteria.
6. **Assertions** run deterministic post-session checks against result artifacts.

Results are written under `results/<scenario>/<backend>/<timestamp>/`, which is
gitignored because those artifacts can contain sensitive transcripts.

## Setup

Install Python dependencies:

```bash
uv sync --extra dev
```

Optional local hooks:

```bash
uv run pre-commit install
uv run pre-commit run --all-files
```

## Safe Checks

These are the checks expected in CI and on routine PRs:

```bash
uv run ruff check
uv run ty check
uv run pytest
```

## Live Eval Prerequisites

Live evals require the relevant backend CLI and credentials.

| Backend family | CLI | Required environment |
| --- | --- | --- |
| Claude | `claude` | `ANTHROPIC_API_KEY`, `SUPERPOWERS_ROOT` |
| Codex | `codex` | `OPENAI_API_KEY` |
| Gemini | `gemini` | local Gemini CLI auth/config |

`SUPERPOWERS_ROOT` defaults to the parent directory of this checkout. That is
correct when Drill is checked out as `superpowers/evals`. In a standalone
`superpowers-evals` clone, set it explicitly:

```bash
export SUPERPOWERS_ROOT=/path/to/superpowers
```

Use a different `SUPERPOWERS_ROOT` when running RED/GREEN comparisons against
modified superpowers skill text.

## Running Live Evals

Run one scenario on one backend:

```bash
uv run drill run worktree-creation-from-main -b claude
```

Run repeated trials:

```bash
uv run drill run spec-writing-blind-spot -b claude-opus-4-6 --n 5
```

Sweep across backend variants:

```bash
uv run drill run spec-writing-blind-spot \
  --models claude-opus-4-6,claude-opus-4-7 \
  --n 10
```

Compare results:

```bash
uv run drill compare spec-writing-blind-spot
```

List scenarios:

```bash
uv run drill list
```

## Backends

Backend configs live in `backends/*.yaml`. They are intentionally
self-contained: command args, required env vars, hooks, idle detection,
terminal size, shutdown behavior, and log locations all live in the backend
file.

Current backend families:

| Backend | CLI | Model / variant |
| --- | --- | --- |
| `claude` | Claude Code | opus default |
| `claude-opus-4-6` | Claude Code | opus-4-6 |
| `claude-opus-4-7` | Claude Code | opus-4-7 |
| `claude-opus-4-6-1m` | Claude Code | opus-4-6, 1M context |
| `claude-opus-4-7-1m` | Claude Code | opus-4-7, 1M context |
| `codex` | Codex CLI | local configured model |
| `gemini` | Gemini CLI | auto-gemini-3 |
| `gemini-2-5-flash` | Gemini CLI | gemini-2.5-flash |

## Scenarios

Scenario files live in `scenarios/*.yaml`. They define setup helpers, user turn
intents, limits, verifier criteria, and deterministic assertions.

| Category | Current coverage |
| --- | --- |
| Worktree | creation, detection, consent, detached HEAD, native-tool pressure |
| Skill triggering | core superpowers skill auto-invocation |
| SDD workflow | explicit invocation, mid-conversation invocation, real projects, YAGNI |
| Review/spec/verification | code review, spec review, targeting, blind spots, verification reflexes |
| Tool mapping | Codex and Gemini subagent/tool-name mapping |
| Cost baselines | token cost, tool-result bloat, duplicated artifacts, review fanout |

## Writing a Scenario

1. Add a setup helper in `setup_helpers/` if the scenario needs a custom repo
   fixture.
2. Register the helper in `setup_helpers/__init__.py`.
3. Add `scenarios/<scenario>.yaml` with setup, turns, limits, and verify
   sections.
4. Run the scenario locally against at least one backend.

Setup helpers take `workdir: Path` and mutate the temporary scenario repo.
Assertions run in the results directory with `$DRILL_WORKDIR` pointing to the
scenario workdir and `bin/` on `PATH`.

## Project Map

```text
drill/              core engine and CLI
  actor.py          user-simulator LLM
  assertions.py     deterministic post-session assertions
  backend.py        backend config loader and command builder
  cli.py            `drill run`, `drill compare`, `drill list`
  engine.py         tmux orchestration and run lifecycle
  normalizer.py     backend log normalization
  session.py        tmux session wrapper
  sweep.py          multi-backend, repeated-run orchestration
  verifier.py       LLM verifier
backends/           backend YAML configs
bin/                assertion helper scripts
docs/               design notes and manual testing protocols
fixtures/           static repo fixtures
prompts/            actor/verifier prompts
scenarios/          scenario YAML files
setup_helpers/      scenario fixture builders
tests/              pytest suite
```

## Contribution Rules

This repo inherits the quality bar of `superpowers`.

- One problem per PR.
- Do not commit generated run artifacts or secrets.
- Do not add live evals to public CI.
- Use the PR template and explain the security/eval-lab risk for changes that
  touch backends, shell execution, setup helpers, assertions, logs, or verifier
  input.
- Changes to behavior-shaping eval methodology need evidence, not just prose.

## Parent Submodule Bump

`superpowers-evals` is consumed by `superpowers` as the `evals` submodule.
After any PR merges to `main` in this repository, open a follow-up PR against
the parent `superpowers` repo targeting `dev` that bumps the `evals` submodule
pointer to the merged `superpowers-evals` commit.

Do not treat a `superpowers-evals` merge as fully propagated until that parent
submodule bump PR exists.

Security reporting details live in [SECURITY.md](SECURITY.md). The broader
design is documented in [docs/design.md](docs/design.md).
