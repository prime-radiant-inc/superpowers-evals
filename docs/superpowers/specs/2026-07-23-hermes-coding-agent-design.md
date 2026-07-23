# Hermes Agent quorum target — design

Date: 2026-07-23
Status: approved (maintainer session, 2026-07-23)

## Problem

Superpowers has a candidate Hermes Agent integration (superpowers PR #1922,
rebased to the `hermes-harness-rebase` branch: a `.hermes-plugin/` that injects
the `using-superpowers` bootstrap at session start over the stock `skills/`
tree). Nothing can test it. The plugin's injection mechanism
(`ctx.inject_message` from `on_session_start`) is not documented by the Hermes
plugin guide (https://hermes-agent.nousresearch.com/docs/developer-guide/plugins),
and the PR's own transcript shows `brainstorming` failing to trigger — so the
first question the eval must answer empirically is whether the shipped
mechanism works at all.

quorum is the harness for exactly this: drive the real CLI headlessly in the
eval container, stage Superpowers from a checkout, and grade skill compliance.
The container already installs the hermes CLI (`container/Dockerfile`,
NousResearch install script, FHS layout, `hermes version` build gate). This
design adds the missing quorum target.

## Decisions (maintainer-confirmed)

1. **The eval tests the real integration.** Provisioning stages
   `.hermes-plugin/` + stock `skills/` from `SUPERPOWERS_ROOT`. No tap-based or
   eval-owned bootstrap bypass. A `SUPERPOWERS_ROOT` without `.hermes-plugin/`
   fails provisioning closed.
2. **Checked-in default credential: `openrouter_glm_5_2`** (GLM 5.2 via
   OpenRouter, `OPENROUTER_API_KEY`), matching pi/opencode. The goal is
   mechanism and skill compliance, not Hermes-model behavior; alternatives stay
   available per-run via `--credential`.
3. **Expected first live result is RED.** The bootstrap scenario is the
   empirical verdict on `ctx.inject_message`; the same scenario then validates
   the `pre_llm_call` / `register_skill` fix when it lands on the superpowers
   branch.

## Hermes facts the design relies on

From the official docs (user-guide/configuration, developer-guide/plugins):

- Config dir `~/.hermes/` (overridable via `HERMES_HOME`; quorum's `$HOME`
  pinning makes the default correct): `config.yaml`, secrets in `.env`,
  OAuth in `auth.json`.
- OpenRouter is a first-class provider: `model: {default, provider:
  "openrouter", base_url}` in `config.yaml`, `OPENROUTER_API_KEY` in `.env`.
- Sessions at `~/.hermes/sessions/` (format documented only as internal),
  logs at `~/.hermes/logs/` (`gateway.log`, `errors.log`), memory under
  `~/.hermes/memories/`.
- Plugins live at `~/.hermes/plugins/<name>/` (`plugin.yaml` + `__init__.py`),
  enabled via `hermes plugins enable <name>`; plugin skills are standard
  markdown registered by path.
- Headless: `hermes chat "<prompt>"` single-turn; `--yes` auto-approves;
  `--no-memory` disables cross-session memory; `-m` overrides model.

## Components

### 1. `coding-agents/hermes.yaml`

- `name: hermes`, `binary: hermes`.
- `home_config_subdir: ".hermes"` — config collapses under the throwaway run
  home; no env override needed.
- `session_log_dir: "${QUORUM_AGENT_HOME}/.hermes/sessions"`, with a
  `session_log_glob` wide enough for the observed layout (see normalizer
  investigation). Capture additionally collects `~/.hermes/logs/`.
- `normalizer: hermes`.
- `required_env: [SUPERPOWERS_ROOT]`.
- `max_time: 10m`, `default_credential: openrouter_glm_5_2` (that credential
  entry gains `hermes` in its `harnesses:` list; concurrency cap stays as the
  credential's `max_concurrency: 5`).

### 2. `coding-agents/hermes-context/HOWTO.md` (+ launcher only if needed)

Gauntlet-facing: how to launch (`hermes` REPL under tmux from the scenario
workdir, `--yes`, `--no-memory`), how to observe progress (session dir, logs),
what "done" looks like, and quirks discovered during the live smoke. The
standard `$QUORUM_HOME_ENV` splice covers `HOME`/XDG/`TMPDIR`; a custom
`launch-agent` script is added only if the generated command alone proves
insufficient (e.g. flags per-launch).

### 3. `src/agents/hermes.ts` (provisioning adapter)

Into `<runHome>/.hermes/`:

- `config.yaml`: provider `openrouter`, `base_url
  https://openrouter.ai/api/v1`, `model.default` from the credential
  (`z-ai/glm-5.2`), memory off if config supports it (belt to `--no-memory`'s
  suspenders).
- `.env` (chmod 0600): `OPENROUTER_API_KEY` from the credential env.
- Plugin staging from `SUPERPOWERS_ROOT`:
  `plugins/superpowers/{__init__.py,plugin.yaml}` copied from
  `.hermes-plugin/`, plus the stock `skills/` tree co-located at
  `plugins/superpowers/skills/` (the layout the plugin's loader expects). Then
  enable — via `hermes plugins enable superpowers` routed through
  `command-runner.ts`, or config/marker file if enabling proves file-driven;
  whichever the live smoke shows actually works headlessly.
- Preflight (fail closed): `SUPERPOWERS_ROOT` contains
  `.hermes-plugin/plugin.yaml` and `skills/using-superpowers/SKILL.md`;
  credential env var present; `hermes` binary on PATH.
- Register in `src/agents/index.ts`; extend the agent config schema only if a
  new field is genuinely needed (none anticipated).

### 4. `src/normalize/hermes.ts`

Maps raw session evidence to ATIF `Trajectory` rows at
`<run>/trajectory.json`. Because the session format is undocumented, the
implementation plan front-loads an investigation task: one in-container
`hermes chat` run against a scratch workdir, inspect
`~/.hermes/sessions/` + `logs/gateway.log`, and write the normalizer against
the observed format (turns, tool calls, model calls at minimum). Strict
capture: an empty normalized trace is a capture failure, not a pass.

### 5. `scenarios/hermes-superpowers-bootstrap`

Gated `# coding-agents: hermes` in `checks.sh`. Asserts:

- Provisioning evidence: plugin staged under the run home, config/`.env`
  seeded, nothing read from the operator's real `~/.hermes`.
- Behavioral evidence: on the acceptance prompt ("Let's make a react todo
  list"), the `using-superpowers` bootstrap content is present in the model
  context (via transcript/log evidence) and `brainstorming` triggers before
  any code is written.

RED on the current plugin is the expected, publishable baseline.

### 6. Docs + static tests

- `docs/coding-agent-care-and-feeding.md` entry (auth = OpenRouter key only,
  capture caveats, the RED-baseline note while the mechanism is unfixed).
- README agent list.
- Container pieces are already present (Dockerfile install, dockerfile test
  tokens, `evals-tool-versions`); touch only if the smoke exposes a gap.

## Testing

- Unit: provisioning adapter (fake command-runner: config/env/plugin staging,
  preflight failures) and normalizer (fixture session files captured from the
  investigation run) under `test/`, following existing per-agent test
  patterns.
- Static: `bun run check`, `bun run quorum check` green.
- Live (trusted-maintainer, container): `scripts/evals-container build`, then
  `bun run quorum run scenarios/hermes-superpowers-bootstrap --coding-agent
  hermes` with `SUPERPOWERS_ROOT` at a `hermes-harness-rebase` checkout.
  Verify per the adding-a-coding-agent checklist: launch under `<run>/home`,
  plugin staged from the checkout, raw evidence where the yaml says,
  `trajectory.json` populated, secrets confined to `results/`.

## Error handling

- Missing `.hermes-plugin/` in `SUPERPOWERS_ROOT` → provisioning error naming
  the branch requirement.
- Missing `OPENROUTER_API_KEY` → loader/provision error (mirror pi's message
  style).
- Empty/absent session evidence after a run → capture failure (strict), not a
  silent pass.
- `hermes plugins enable` failing headlessly → provisioning error with the
  command output (this is the likeliest first live failure; the HOWTO records
  the workaround once found).

## Out of scope

- Fixing the superpowers-side plugin mechanism (tracked on superpowers PR
  #1922 / the `hermes-harness-rebase` branch).
- Nous Portal auth, Hermes-native models, gateway/messaging modes, memory
  evals.
- Public-CI live runs (unchanged safety rule: live evals are
  trusted-maintainer operations).
