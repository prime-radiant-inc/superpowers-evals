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
  Code, Codex CLI, Gemini CLI, or Pi in permissive modes and may collect raw
  transcripts, tool calls, filesystem state, and local session logs.

Public CI must stay on the static/unit side of that line. Do not add API keys,
live `drill run ...` sweeps, or dangerous-mode agent launches to public CI.

## Live Eval Risk

Live evals intentionally run the backend under test with broad execution power:

- Claude backends use `--dangerously-skip-permissions`
- Codex uses `--dangerously-bypass-approvals-and-sandbox`
- Gemini uses `--yolo`
- Pi loads the local Superpowers package with `-e ${SUPERPOWERS_ROOT}`

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

## The Harness

`harness/` is the Python wrapper around **Gauntlet** — a general-purpose
QA-agent framework (a separate repo; its `gauntlet` CLI must be on `PATH`).
It owns scenario setup, Coding-Agent adaptation, deterministic checks, and
the final verdict. Full rationale lives in
[`docs/gauntlet-migration.md`](docs/gauntlet-migration.md).

### Canonical Actors

Keep the actors straight; confusing them is the most common triage error.
These names are used everywhere — docs, CLI output, code, filenames, commit
messages.

| Actor | What it is | Where it lives / its files |
|---|---|---|
| **Gauntlet** | General-purpose QA framework; the `gauntlet` CLI. A black-box tester. | repo `~/Code/prime/gauntlet`; on `PATH` as `gauntlet` |
| **Gauntlet-Agent** | The LLM *inside* Gauntlet that drives the system-under-test and self-grades against the story's ACs. | model e.g. `claude-sonnet-4-6`; event stream → `<run>/gauntlet-agent/results/<runId>/run.jsonl`; verdict → `result.{json,md}` |
| **Coding-Agent** | The agent under test — the SUT. Instances: **Claude**, **Codex**; future **Gemini**, **Pi**. | session log → `<run>/coding-agent-config/…`; the files it writes → `<run>/coding-agent-workdir/` |
| **Harness** | The Python wrapper. Owns setup, Coding-Agent adaptation, the deterministic checks, and the final verdict. | repo `superpowers-evals/harness/`; `<run>/verdict.json` |

A run involves **two** LLMs — the **Gauntlet-Agent** (QA tester) and the
**Coding-Agent** (subject). Separate models, separate logs, separate token costs.
Confusing them is the most common triage error.

### Scenario Layout

A harness scenario is a directory, `harness/scenarios/<name>/`:

```text
story.md    Gauntlet story — the QA agent's brief + acceptance criteria
setup.sh    builds the fixture workdir (runs before the Coding-Agent)
checks.sh   deterministic checks — pre() + post() bash functions
```

`story.md` carries YAML frontmatter (`id`, `title`) and an
`## Acceptance Criteria` section. Write criteria to demand log evidence
(e.g. "a `Skill` invocation naming `superpowers:writing-plans` appears in
the Coding-Agent's session log") so the Gauntlet-Agent must consult the
log, not just the screen.

### `checks.sh` Format

`checks.sh` is a plain bash script containing exactly two functions —
`pre()` and `post()` — and nothing else at the top level:

```bash
# coding-agents: claude,codex   ← optional; restricts which agents run this scenario
pre() {
    git-repo
    git-branch main
}

post() {
    file-exists "docs/plan.md"
    skill-called superpowers:writing-plans
}
```

`pre()` runs after `setup.sh`, before the Coding-Agent starts. `post()`
runs after the Coding-Agent's session is captured. The optional
`# coding-agents: <csv>` magic comment at the top restricts which
Coding-Agents the scenario is valid for; omit it to allow all agents.

Scripts must have **no exec bit** and contain only function definitions.
Invoke check tools by name — they are on `PATH` via `harness/bin/`.

### Check Vocabulary (`harness/bin/`)

Every tool emits one JSON record per invocation. A non-zero exit means the
check failed; the record carries a `detail` string explaining why.

**Artifact surface** — the filesystem the Coding-Agent produced:
- `file-exists <glob>` — a path matching the glob exists.
- `file-contains <path> <regex>` — the file exists and matches the regex.
- `command-succeeds <cmd>` — the command, run in the Coding-Agent's workdir, exits 0. Use for project build/test commands (`go test ./…`, `npm test`), not as a substitute for `file-contains`.

**Git surface** — git state the Coding-Agent shaped:
- `git-repo` — the workdir is a git work tree.
- `git-branch <name>` — current branch equals name; use `detached` for detached HEAD.
- `git-clean` — the working tree has no uncommitted changes.
- `git-count worktrees|commits <op> <n>` — the count satisfies the comparison (`eq`, `ne`, `gt`, `gte`, `lt`, `lte`).

**Trace surface** — the Coding-Agent's normalized tool-call log (`coding-agent-tool-calls.jsonl`):
- `tool-called <tool>` — the tool appears in the trace at least once.
- `tool-count <tool> <op> <n>` — the call count satisfies the comparison.
- `tool-before <a> <b>` — tool `a` was called before tool `b`.
- `tool-arg-match <tool> <jq>` — at least one call to `tool` has args matching the jq filter.
- `tool-match-before-tool-match <tool-a> <jq-a> <tool-b> <jq-b>` — a matching call to `a` precedes a matching call to `b`.
- `skill-called <skill>` — a `Skill` invocation names the given skill.
- `skill-not-called <skill>` — no `Skill` invocation names the given skill.
- `skill-before-tool <skill> <tool>` — the skill was invoked before the tool.
- `skill-before-tool-match <skill> <tool> <jq>` — the skill was invoked before a matching call to `tool`.

**Negation:**
- `not <check> [args…]` — runs the inner check without emitting a record, inverts the result, and emits one negated record. Always use `not` rather than bash's bare `!`.

The shared `_record` helper (sourced by every tool) handles record emission and an `ERR` trap so a crashing tool never silently drops out of the verdict.

### Verdict

The harness produces a **three-valued verdict** — `pass | fail | indeterminate`:

- `pass` — Gauntlet-Agent passed **and** every post-check passed.
- `fail` — Gauntlet-Agent failed, or a post-check failed.
- `indeterminate` — a pre-check failed (invalid fixture), Gauntlet-Agent returned `investigate`, the capture was empty while a trace check was present, or the Harness itself errored. An `indeterminate` run is not a finding — it is a signal that the run did not execute cleanly.

The structured `verdict.json` (schema v1) contains:
- `gauntlet` layer — `status`, `summary`, `reasoning`, `run_id`.
- `checks` layer — an array of records from `pre()` and `post()`, each with `check`, `args`, `negated`, `passed`, `detail`, `phase`.
- `final` — the composed `pass | fail | indeterminate`.
- `final_reason` — a human-readable explanation of the verdict.
- `error` — present if the Harness itself threw; includes `stage` and `message`.

**Exit codes:** 0 = pass, 1 = fail, 2 = indeterminate.

### Run Directory Layout

Each run produces one directory under `results-harness/`, with every entry
prefixed by the actor it belongs to:

```text
results-harness/<scenario>-<coding-agent>-<timestamp>/
├── verdict.json                     the composed result — the front door
├── gauntlet-agent/                  the Gauntlet-Agent's evidence
│   └── results/<runId>/
│       ├── result.{json,md}         the Gauntlet-Agent's verdict
│       ├── run.jsonl                the Gauntlet-Agent's event stream
│       ├── inputs/story.md
│       └── captures/
├── coding-agent-workdir/            the Coding-Agent's file output
├── coding-agent-config/             the Coding-Agent's isolated config home
├── coding-agent-tool-calls.jsonl    the Coding-Agent's normalized trace
└── coding-agent-token-usage.json    the Coding-Agent's token cost
```

`results-harness/` is gitignored because run artifacts can contain sensitive
transcripts.

### Refreshing the Claude skeleton

The dialog-bypass skeleton at `fixtures/skeleton-claude-home/` is committed —
fresh checkouts / worktrees / CI runners boot Claude straight to the prompt
with no per-machine setup. It carries only the ~12 universal dialog-bypass
flags (`hasCompletedOnboarding`, `installMethod`, migration markers, etc.);
the refresh script scrubs all per-user / per-machine / per-key fields before
writing.

You only need to refresh when Claude Code adds new onboarding state (a
previously-skipped picker reappearing in a tmux-attach is the usual symptom):

```bash
# 1. Run Claude with a fresh config dir; click through every dialog with your
#    real ANTHROPIC_API_KEY active. Once you reach the prompt, /exit.
CLAUDE_CONFIG_DIR=/tmp/claude-source claude

# 2. Rebuild the fixture; commit the diff.
bin/refresh-skeleton-claude-home --source /tmp/claude-source
git diff fixtures/skeleton-claude-home/   # sanity-check the scrubbed result
git commit fixtures/skeleton-claude-home/ -m "harness: refresh Claude skeleton"
```

For Codex no skeleton is needed — `_seed_codex_auth` provisions a fresh per-run
home from your `OPENAI_API_KEY` each run.

### Running Harness Scenarios

Run one scenario against one Coding-Agent:

```bash
uv run harness run harness/scenarios/triggering-writing-plans --coding-agent claude
```

List scenarios:

```bash
uv run harness list
```

Scaffold a new scenario, then validate its structure:

```bash
uv run harness new my-new-scenario
uv run harness check my-new-scenario
```

`harness check` with no arguments validates every scenario.

Harness runs are **live evals** — they launch real agent CLIs in permissive
modes. The [Safety Model](#safety-model) and [Live Eval Risk](#live-eval-risk)
sections apply unchanged; never run them on public CI. The per-run config-dir
isolation narrows the blast radius but is not a sandbox.

### Coding-Agents

A coding-agent is one agent CLI under test. Its config is
`harness/coding-agents/<name>.yaml`; its companion HOWTO,
`harness/coding-agent-contexts/<name>/HOWTO.md`, is prose the Gauntlet-Agent
reads to learn how to launch and observe that CLI. Both are authored once per
CLI and shared across scenarios.

| Coding-Agent | CLI | Required environment |
| --- | --- | --- |
| `claude` | Claude Code | `ANTHROPIC_API_KEY`, `SUPERPOWERS_ROOT` |
| `codex` | Codex CLI | `OPENAI_API_KEY`, `SUPERPOWERS_ROOT` |

Note: Gauntlet's own `gauntlet` CLI preserves its `--target <binary>` flag for
selecting the TUI adapter binary; the Harness's `--coding-agent` flag is a
separate, higher-level concept that selects the agent config.

### How the Harness Works

A `harness run` drives one scenario against one Coding-Agent:

1. **Coding-Agent config** — `harness/coding-agents/<name>.yaml` is parsed and
   its required env vars validated.
2. **Run dir** — a per-run directory is created under `results-harness/`.
   It doubles as Gauntlet's `--state-dir` root and the evidence root.
3. **Isolation** — a fresh per-run agent-config dir (`CLAUDE_CONFIG_DIR`
   for Claude, `CODEX_HOME` for Codex) is seeded from a skeleton, so the
   Coding-Agent never sees the host's real `~/.claude` / `~/.codex`,
   installed plugins, or prior sessions.
4. **Setup** — the Coding-Agent's workdir is created inside the run dir as
   `coding-agent-workdir/`; the scenario's `setup.sh` builds the fixture.
5. **Pre-checks** — `checks.sh`'s `pre()` runs against the workdir; a failure
   marks the run `indeterminate` before the Coding-Agent is launched.
6. **Context** — the per-agent HOWTO (`harness/coding-agent-contexts/<name>/`)
   is copied into the run's `gauntlet-agent/context/` so the Gauntlet-Agent
   learns how to launch and observe the Coding-Agent.
7. **Drive** — `gauntlet run story.md --adapter tui --state-dir gauntlet-agent`
   launches. The Gauntlet-Agent reads the screen and the Coding-Agent's session
   log via bash, role-plays the user, and issues a verdict against the story's
   `## Acceptance Criteria`.
8. **Capture** — the Coding-Agent's session-log dir is diffed, normalized into
   `coding-agent-tool-calls.jsonl`, and token usage written to
   `coding-agent-token-usage.json` (measurement only).
9. **Post-checks** — `checks.sh`'s `post()` runs against the captured evidence.
10. **Compose** — the final verdict is `pass` iff the Gauntlet-Agent passed
    **and** every post-check passed. `verdict.json` is written to the run dir.

### Writing a Harness Scenario

1. `uv run harness new <name>` stamps a structurally-valid skeleton.
2. Write `story.md`: brief the Gauntlet-Agent on the role it plays, the exact
   message to send the Coding-Agent, and when it is done — plus
   evidence-demanding acceptance criteria. Follow the
   `writing-gauntlet-stories` skill.
3. Write `setup.sh` to build the fixture. Prefer
   `uv run setup-helpers run <helper>` over inline Python; if you need a
   new fixture, add a helper to `setup_helpers/` and register it in
   `setup_helpers/__init__.py`.
4. Write `checks.sh` with `pre()` and `post()` functions using the
   `harness/bin/` vocabulary. No exec bit.
5. `uv run harness check <name>` to validate structure, then run it
   against a coding-agent.

Setup scripts run with `$HARNESS_WORKDIR` pointing at the fixture workdir.
Check tools run with `harness/bin/` on `PATH` and `$HARNESS_WORKDIR` set.

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
| Codex | `codex` | `OPENAI_API_KEY`, `SUPERPOWERS_ROOT` |
| Gemini | `gemini` | local Gemini CLI auth/config |
| Pi | `pi` | `SUPERPOWERS_ROOT` |

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

Run against Pi, loading the local Superpowers package from `SUPERPOWERS_ROOT`:

```bash
uv run drill run triggering-writing-plans -b pi
```

Verify Codex native plugin hooks bootstrap Superpowers from an isolated
`CODEX_HOME`:

```bash
uv run drill run codex-native-hooks-bootstrap -b codex
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
| `codex` | Codex CLI with native plugin hooks in isolated `CODEX_HOME` | local configured model |
| `codex-no-hooks` | Codex CLI with legacy `.agents` symlink setup | local configured model |
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
| Harness bootstrap | Codex native plugin hook startup behavior |

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
drill/              Drill core engine and CLI (legacy; Phase 3 removes it)
  actor.py          user-simulator LLM
  assertions.py     deterministic post-session assertions
  backend.py        backend config loader and command builder
  cli.py            `drill run`, `drill compare`, `drill list`
  engine.py         tmux orchestration and run lifecycle
  normalizer.py     backend log normalization
  session.py        tmux session wrapper
  sweep.py          multi-backend, repeated-run orchestration
  verifier.py       LLM verifier
harness/            Gauntlet-based harness
  cli.py            `harness run`, `list`, `new`, `check`
  runner.py         per-run orchestration (one scenario, one coding-agent)
  coding_agent_config.py  per-coding-agent YAML loader
  setup_step.py     runs scenario setup.sh
  checks.py         sources checks.sh, runs pre()/post(), collects records
  capture.py        session-log snapshot/diff + token capture
  normalizers.py    per-coding-agent session-log normalization
  composer.py       three-valued verdict from gauntlet + checks layers
  scaffold.py       `harness new` / `harness check`
  token_usage.py    per-coding-agent token-usage parsing
  bin/              check-tool vocabulary (_record, file-exists, file-contains,
                    command-succeeds, git-repo, git-branch, git-clean, git-count,
                    tool-called, tool-count, tool-before, tool-arg-match,
                    skill-called, skill-before-tool, not, and more)
  coding-agents/    per-coding-agent config YAML (claude, codex)
  coding-agent-contexts/  per-coding-agent HOWTO prose for the Gauntlet-Agent
  scenarios/        harness scenarios (one directory each)
backends/           Drill backend YAML configs
bin/                assertion helper scripts (shared by Drill and harness)
docs/               design notes, the migration spec, testing protocols
fixtures/           static repo fixtures + agent-config skeletons
prompts/            Drill actor/verifier prompts
scenarios/          Drill scenario YAML files
setup_helpers/      scenario fixture builders (shared) + `setup-helpers` CLI
tests/              pytest suite (tests/harness/ covers the harness)
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
