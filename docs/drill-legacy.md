# Drill (legacy)

Drill is the predecessor to the Harness. It is being removed; this doc preserves
its usage notes until the code is deleted. **Do not write new scenarios against
Drill** — use the Harness ([README](../README.md)).

Drill drives real coding-agent CLIs through tmux sessions and checks whether
they invoke and follow superpowers skills correctly. It is being superseded by
the Harness, which delegates the QA-agent role to Gauntlet and replaces the
LLM verifier with a deterministic `checks.sh` vocabulary. The migration
rationale lives in [gauntlet-migration.md](gauntlet-migration.md).

## How Drill Works

1. **Setup** creates a temporary git repo with scenario-specific conditions.
2. **Actor** uses Sonnet to simulate a realistic user from the scenario turns.
3. **Agent** runs the backend under test in a tmux session.
4. **Collection** captures terminal output, filesystem state, and tool calls.
5. **Verifier** uses Sonnet to judge the transcript against semantic criteria.
6. **Assertions** run deterministic post-session checks against result artifacts.

Results are written under `results/<scenario>/<backend>/<timestamp>/`, which is
gitignored because those artifacts can contain sensitive transcripts.

## Running Drill

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

| Category | Coverage |
| --- | --- |
| Worktree | creation, detection, consent, detached HEAD, native-tool pressure |
| Skill triggering | core superpowers skill auto-invocation |
| SDD workflow | explicit invocation, mid-conversation invocation, real projects, YAGNI |
| Review/spec/verification | code review, spec review, targeting, blind spots, verification reflexes |
| Tool mapping | Codex and Gemini subagent/tool-name mapping |
| Cost baselines | token cost, tool-result bloat, duplicated artifacts, review fanout |
| Harness bootstrap | Codex native plugin hook startup behavior |

## Writing a Drill Scenario

1. Add a setup helper in `setup_helpers/` if the scenario needs a custom repo
   fixture.
2. Register the helper in `setup_helpers/__init__.py`.
3. Add `scenarios/<scenario>.yaml` with setup, turns, limits, and verify
   sections.
4. Run the scenario locally against at least one backend.

Setup helpers take `workdir: Path` and mutate the temporary scenario repo.
Assertions run in the results directory with `$DRILL_WORKDIR` pointing to the
scenario workdir and `bin/` on `PATH`.

## Drill Project Layout

```text
drill/              Drill core engine and CLI
  actor.py          user-simulator LLM
  assertions.py     deterministic post-session assertions
  backend.py        backend config loader and command builder
  cli.py            `drill run`, `drill compare`, `drill list`
  engine.py         tmux orchestration and run lifecycle
  normalizer.py     backend log normalization
  session.py        tmux session wrapper
  sweep.py          multi-backend, repeated-run orchestration
  verifier.py       LLM verifier
backends/           Drill backend YAML configs
bin/                Drill assertion helper scripts (frozen; separate from harness/bin/)
prompts/            Drill actor/verifier prompts
scenarios/          Drill scenario YAML files
```

`setup_helpers/` and `fixtures/` are shared with the Harness and stay live
after Drill is removed.
