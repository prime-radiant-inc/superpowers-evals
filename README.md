# Superpowers Evals

Behavioral eval lab for [superpowers](https://github.com/obra/superpowers).
**Quorum** drives real coding-agent CLIs (Claude, Claude Haiku, Claude
Sonnet, Codex, Antigravity, Gemini, Kimi, OpenCode, Pi, and Copilot) through a
Gauntlet QA agent and grades them against scenario acceptance criteria plus
deterministic post-checks.

Code, CLI, paths, and inline prose all use lowercase `quorum`; the capitalized
form `Quorum` appears in headings and the actor table.

This is not a generic benchmark suite. It is an eval lab for workflow
compliance: skill triggering, worktree behavior, subagent coordination,
verification reflexes, review quality, and cost-shaping patterns.

## Safety Model

quorum has two very different execution modes:

- **Static/unit checks** are safe for public CI. They run `biome`, `tsc`, and
  `bun test`. They do not call model APIs and do not launch agent CLIs.
- **Live evals** are trusted-maintainer operations. They launch Claude Code,
  Codex CLI, Antigravity CLI, Gemini CLI, Kimi Code, OpenCode CLI, Pi CLI, or
  Copilot CLI in permissive modes and collect raw transcripts, tool calls,
  filesystem state, and session logs.

Public CI must stay on the static/unit side of that line. Never add API keys,
live `quorum run …` invocations, or dangerous-mode agent launches to public
CI.

## Live Eval Risk

Live evals run the Coding-Agent under test with broad execution power:

- Claude, Claude Haiku, and Claude Sonnet use
  `--dangerously-skip-permissions`.
- Codex uses `--dangerously-bypass-approvals-and-sandbox`.
- Antigravity uses `--dangerously-skip-permissions` and relies on local
  browser/keyring auth for `agy`.
- Gemini uses `--skip-trust --approval-mode=yolo`; API-key auth is default,
  with opt-in OAuth auth for trusted local runs.
- Kimi uses `--yolo`.
- OpenCode uses `--dangerously-skip-permissions`.
- Pi uses explicit tool allowlists and API-key auth in a run-local config dir.
- Copilot uses `--allow-all`.

quorum pins each Coding-Agent's `HOME` (plus the XDG base dirs and `TMPDIR`)
to a throwaway per-run home at `<run>/home` — the launcher splices in the
`$QUORUM_HOME_ENV` token built by `src/agents/home-env.ts` (`xdgHomeEnv`, the
single source of truth). Each agent's config dir is collapsed *under* that home
(Claude `.claude`, Codex `.codex`, Gemini `.`, OpenCode `.`, Antigravity `.`,
Copilot `.copilot`, Kimi `.kimi-code`, Pi `.pi/agent`), so the Coding-Agent
finds its config via its own `$HOME` default and never sees the host's real
`~/.claude`, `~/.codex`, `~/.gemini`, `~/.kimi-code`, `~/.pi`, `~/.copilot`,
`~/.config`, or other home-relative state, installed plugins, or prior sessions.
Provisioning seeds the config — and the host OAuth creds each agent needs — into
that throwaway home before launch, so there is no run-time login. Copilot also
stages the local Superpowers plugin under the isolated home, uses an
allowlisted outer environment, and writes a secret-bearing chmod-0600
`.copilot-env` inside the run dir. That narrows the blast radius but is not a
sandbox. OpenCode and Copilot launchers additionally use allowlisted
environments, but live Coding-Agents still run with broad filesystem and
command execution power.

Run live evals only from a trusted local environment:

- Export only the API key needed for the selected Coding-Agent.
- Avoid running with broad production or personal secrets in the environment.
- Treat `results/`, raw session logs, session-state/tool-call artifacts, and
  Gauntlet-Agent inputs as
  sensitive.
- Do not commit or paste raw run artifacts without checking them first.

## Quick Start

Install and run the static gates:

```bash
bun install
bun run check
bun run quorum check
```

Run one local scenario outside the container:

```bash
export SUPERPOWERS_ROOT=/path/to/superpowers
export ANTHROPIC_API_KEY=...
bun run quorum run scenarios/triggering-writing-plans --coding-agent claude
bun run quorum show <run-dir>
```

Agent names are `claude`, `claude-haiku`, `claude-sonnet`, `codex`,
`antigravity`, `gemini`, `kimi`, `opencode`, `pi`, and `copilot`. Not every
scenario is valid for every agent.

## Container Runtime

The Docker runtime is the primary recipe for real suite runs. It keeps the
evals checkout, the Superpowers checkout under test, credentials, auth sources,
and all run artifacts on the host while quorum runs inside a rich Ubuntu
workspace container.

Create `.env.container` or pass an explicit env file to `up`:

```dotenv
ANTHROPIC_API_KEY=...
OPENAI_API_KEY=...
GEMINI_API_KEY=...          # or GEMINI_AUTH_TYPE=oauth-personal
KIMI_MODEL_API_KEY=...      # unless using mounted Kimi OAuth
PI_PROVIDER=...
PI_MODEL=...
PI_API_KEY=...              # unless using mounted Pi OAuth
COPILOT_GITHUB_TOKEN=...
```

Then build, start, and validate the container:

```bash
scripts/evals-container build
scripts/evals-container down || true
scripts/evals-container --env-file .env.container up
scripts/evals-container exec evals-tool-versions
scripts/evals-container exec quorum check
```

The wrapper mounts this evals checkout at `/workspace/evals`, the parent
Superpowers checkout at `/workspace/superpowers`, and host `results/` at
`/workspace/evals/results`. Override the Superpowers checkout with
`--superpowers-root <dir>` when the default parent path is not the system under
test.

The image build needs a local Gauntlet checkout. The wrapper discovers it
from `GAUNTLET_ROOT` or a Bun global `bun link` install; use
`--gauntlet-root <dir>` with `build` to choose explicitly.

Credentials are read-only mounts. By default, `up` uses `.env.container` first,
then `.env`, and mounts the first one found at `/run/evals/credentials.env`.
Pass `--env-file <file>` before `up` to choose explicitly. The wrapper does not
pass the host environment wholesale; only the in-container `quorum` shim sources
the dotenv file, so `scripts/evals-container exec bash ...` does not
automatically receive live eval credentials. Use `down` before changing the
env-file mount on an existing container.

OAuth/file auth sources are also read-only. Existing `~/.codex`, `~/.gemini`,
`~/.kimi-code`, and `~/.pi` directories mount to `/auth/codex`, `/auth/gemini`,
`/auth/kimi-code`, and `/auth/pi`. Use `--auth codex=<dir>`,
`--auth gemini=<dir>`, `--auth kimi=<dir>`, or `--auth pi=<dir>` to override a
source.

Start with the sentinel suite:

```bash
scripts/evals-container exec quorum run-all \
  --tier sentinel \
  --coding-agents claude,claude-haiku,claude-sonnet,codex,kimi \
  --jobs 4

for agent in gemini opencode pi copilot; do
  scripts/evals-container exec quorum run-all \
    --tier sentinel \
    --coding-agents "$agent" \
    --jobs 1
done
```

Run the same commands without `--tier sentinel` for the full ready suite.
`run-all` writes each batch under `results/batches/<batch-id>/` and each run
under `results/<scenario>-<agent>-<timestamp>-<nonce>/`; render a batch with:

```bash
scripts/evals-container exec quorum show <batch-id>
```

`run-all` prints a periodic liveness heartbeat
(`⋯ … · running N/jobs · done D · queued Q · [agent:scenario, …]`); tune it with
`--heartbeat-seconds <n>` (`0` disables). Interrupting a batch — Ctrl-C, or the
`exec` session closing — stops it gracefully: the queue is cancelled, in-flight
runs are SIGINT'd (and recorded as stopped), and the batch footer is still
written, so `finished_at` is never left null.

The container runtime does not mount the Docker socket, publish dashboard ports,
or include desktop IDEs. The image omits Antigravity's desktop `agy` installer;
run Antigravity host-side until there is a headless install path:

```bash
bun run quorum run-all --coding-agents antigravity --jobs 1
```

For grouped all-agent host sweeps, per-agent credentials, auth mount details,
and troubleshooting, use [docs/coding-agent-care-and-feeding.md](docs/coding-agent-care-and-feeding.md).

## Windows Runtime

For evals against native Windows Claude, see [docs/windows/eval-runtime.md](docs/windows/eval-runtime.md) (Linux+KVM hosts only).

## Canonical Actors

Keep the actors straight; confusing them is the most common triage error.
These names are used everywhere — docs, CLI output, code, filenames, commit
messages.

| Actor | What it is | Where it lives / its files |
|---|---|---|
| **Gauntlet** | General-purpose QA framework; the `gauntlet` CLI. A black-box tester. | repo `~/Code/prime/gauntlet`; on `PATH` as `gauntlet` |
| **Gauntlet-Agent** | The LLM *inside* Gauntlet that drives the Coding-Agent and self-grades against the story's ACs. | model e.g. `claude-sonnet-4-6`; event stream → `<run>/gauntlet-agent/results/<runId>/run.jsonl`; verdict → `result.{json,md}` |
| **Coding-Agent** | The agent under test — the SUT. Instances: **Claude**, **Claude Haiku**, **Claude Sonnet**, **Codex**, **Antigravity**, **Gemini**, **Kimi**, **OpenCode**, **Pi**, **Copilot**. | config + session log under its throwaway `$HOME` at `<run>/home/…`; the files it writes → `<run>/coding-agent-workdir/` |
| **Quorum** | The TypeScript/Bun wrapper. Owns setup, Coding-Agent adaptation, deterministic checks, and the final verdict. | repo `superpowers-evals/src/`; `<run>/verdict.json` |

A run involves **two** LLMs — the **Gauntlet-Agent** (QA tester) and the
**Coding-Agent** (subject). Separate models, separate logs, separate token
costs.

## Operator Guides

- [docs/scenario-authoring.md](docs/scenario-authoring.md) - scenario anatomy,
  story/AC craft, setup helpers, check verbs, and authoring traps.
- [docs/coding-agent-care-and-feeding.md](docs/coding-agent-care-and-feeding.md)
  - credentials, sweeps, per-agent runtime notes, and troubleshooting.
- [docs/adding-a-coding-agent.md](docs/adding-a-coding-agent.md) - checklist
  for adding a new agent target, launcher, provisioner, normalizer, and smoke.
- [docs/superpowers/skills/triaging-a-failing-eval.md](docs/superpowers/skills/triaging-a-failing-eval.md)
  - attribution atlas for non-passing runs.
- [docs/baselines/](docs/baselines/) - current known-good baselines by backend.

## Core Commands

```bash
bun run quorum list
bun run quorum new my-new-scenario
bun run quorum check my-new-scenario
bun run quorum run scenarios/<name> --coding-agent <agent>
bun run quorum run-all --coding-agents claude,codex --jobs 2
bun run quorum show <run-or-batch-id>
bun run quorum costs <run-or-batch-id>
```

`quorum check` with no arguments validates every scenario. `run-all` runs every
included scenario against every selected Coding-Agent, filtered by each
scenario's `# coding-agents:` directive.

## Verdicts And Artifacts

quorum produces a three-valued verdict:

- `pass` - Gauntlet-Agent passed and every post-check passed.
- `fail` - Gauntlet-Agent failed, or a post-check failed.
- `indeterminate` - setup/pre-check/capture/quorum failure, Gauntlet
  `investigate`, or empty trace when trace checks are present.

Exit codes are 0 for `pass`, 1 for `fail`, and 2 for `indeterminate`.

Each run produces one directory under `results/`:

```text
results/<scenario>-<coding-agent>-<timestamp>-<nonce>/
|-- verdict.json                     composed result; start here
|-- gauntlet-agent/                  Gauntlet-Agent evidence
|-- coding-agent-workdir/            files the Coding-Agent produced
|-- home/                            throwaway Coding-Agent HOME
|-- trajectory.json                  normalized ATIF trace
`-- coding-agent-token-usage.json    Coding-Agent token cost, when priced
```

`results/` is gitignored because run artifacts can contain sensitive
transcripts, credentials, tool calls, and filesystem state.

## Safe Checks

These are the checks expected in CI and on routine PRs:

```bash
bun run check          # biome ci . && tsc --noEmit && bun test — the full gate
bun run quorum check   # validate every scenario directory
```

`bun run check` is the single gate (Biome lint/format + full-strict `tsc` +
`bun test`); individual steps are `bun run lint`, `bun run typecheck`, and
`bun test`.

## Architecture

quorum is **TypeScript on Bun**. The console is `bun run quorum <cmd>` (a
[commander](https://github.com/tj/commander.js) CLI at `src/cli/index.ts`, also
exposed as the `quorum` bin); the gate is `bun run check`
(Biome + full-strict `tsc` + `bun test`).

The shapes that cross process and file boundaries — `verdict.json`, batch
indices, economics, the Gauntlet result, agent YAML — are **zod schemas** in
`src/contracts/`, validated at every boundary, so a malformed external file
fails loudly instead of corrupting a verdict. The `cli/` layer parses commands
and dispatches into the `runner/` pipeline (one scenario × one Coding-Agent) or
`run-all/` (the matrix). Per-Coding-Agent differences live in two parallel
fan-outs keyed by agent name: `agents/` seeds the agent's config under the
throwaway per-run `$HOME` (`<run>/home`), and `normalize/` turns that agent's
session log into a uniform tool-call trace. Live agent-CLI calls and other
non-hermetic subprocesses go through the
`agents/command-runner.ts` seam, so the unit suite injects fakes and never
launches a real CLI. `scheduler/` is the shared concurrency engine under both
`run-all/` and the `dashboard/`. `env.ts` is the only module that reads
`process.env`.

```text
src/
  cli/                  commander CLI: run, list, new, check, show, costs, run-all, dashboard
    index.ts              command wiring + run / costs / run-all / dashboard actions
    render.ts             verdict renderer for triage (quorum show)
    render-batch.ts       batch-matrix renderer (quorum show <batch>)
    resolve-target.ts     run/batch target resolution; scenario.ts scenario loading
  runner/               per-run orchestration (one scenario × one Coding-Agent)
    index.ts              setup → pre-checks → gauntlet drive → capture → post-checks → compose
    context.ts            populate the Gauntlet-Agent context dir (HOWTO + launch-agent shim)
    phase.ts              phase.json (setup/agent/checks) for the dashboard
    stopped.ts            SIGINT → stopped (indeterminate) verdict; errors.ts staged run-error stages
  agents/               per-Coding-Agent provisioning (resolveAgent dispatch)
    index.ts              agent registry + dispatch (incl. the inline Claude/Default adapters)
    command-runner.ts     injectable subprocess seam (live CLIs faked in tests)
    <agent>.ts            codex/gemini/kimi/opencode/pi/copilot/antigravity adapters
  normalize/            session-log → normalized tool-call trace, one module per dialect
  capture/              session-log snapshot/diff + tool-call capture + token usage; cwd-filter
  obol/                 obol cost estimation (session-log + gauntlet sidecar)
  economics.ts          token-cost composition → coding-agent-token-usage.json
  composer.ts           three-valued verdict from the gauntlet + checks layers
  checks/               sources prelude.sh + checks.sh, runs pre()/post(), collects check records
    prelude.sh            bare-verb DSL: defines each check verb as a bash function that
                          delegates to the TS dispatchers (no bin/ shims, no PATH prepend)
  scheduler/            central concurrency dispatcher (one global slot pool, per-harness limits + spacing)
  run-all/              scenario × Coding-Agent matrix over the scheduler; batch index
  dashboard/            web matrix UI: read-side scan/view, typed HTML templates, SSE bus, orchestrator, Bun.serve
  setup-helpers/        scenario fixture builders + the `setup-helpers` CLI (dispatch registry)
  contracts/            zod schemas at the JSON boundaries (verdict, batch, economics, gauntlet, agent-config)
  scaffold.ts           `quorum new` / `quorum check`
  setup-step.ts         runs scenario setup.sh (sources prelude.sh via BASH_ENV so bare verbs resolve)
  story-meta.ts         story.md frontmatter (quorum_max_time, quorum_tier, status)
  env.ts                the single process.env boundary
  paths.ts              repo root, UTC stamps, nonces
  invariant.ts          assertNever exhaustiveness guard for closed unions
  check/                typed check verbs: fs-verbs.ts (file/git/env + bootstrap),
                        dispatch.ts (table + `not`), transcript-dispatch.ts, record.ts (sole emitter)
  cli/check-tool.ts     the dispatcher behind every check verb function (file-exists,
                        file-contains, command-succeeds, git-*, assert-checkout-clean,
                        requires-tool, not, files-exist, the *-installed/hook/extension
                        checks); check-transcript.ts and setup-helpers/cli.ts are the
                        other two dispatchers the prelude delegates to
  cli/list-check-verbs.ts  prints the FS_VERBS verb set the prelude loops over (drift-proof)
coding-agents/          per-Coding-Agent material:
  <name>.yaml             CLI config
  <name>-context/         HOWTO prose and launchers for the Gauntlet-Agent
scenarios/              scenarios (one directory each)
fixtures/               shared static fixture repos (e.g. template-repo/, sdd-*/)
test/                   bun test suite
docs/                   design notes, specs, plans, testing protocols, baselines
```

## Triage

Triaging a non-passing run starts with:

```bash
bun run quorum show [<target>]
```

Then use [docs/superpowers/skills/triaging-a-failing-eval.md](docs/superpowers/skills/triaging-a-failing-eval.md)
for the attribution atlas. For agent-specific auth, provisioning, and capture
checks, use [docs/coding-agent-care-and-feeding.md](docs/coding-agent-care-and-feeding.md).

For the current known-good baseline, see [docs/baselines/](docs/baselines/).

## Contribution Rules

This repo inherits the quality bar of `superpowers`.

- One problem per PR.
- Do not commit generated run artifacts or secrets.
- Do not add live evals to public CI.
- Use the PR template and explain the security/eval-lab risk for changes that
  touch Coding-Agent configs, shell execution, setup helpers, check tools, or
  Gauntlet-Agent input.
- Changes to behavior-shaping eval methodology need evidence, not just prose.

## Parent Submodule Bump

`superpowers-evals` is consumed by `superpowers` as the `evals` submodule.
After any PR merges to `main` here, open a follow-up PR against the parent
`superpowers` repo targeting `dev` that bumps the `evals` submodule pointer to
the merged `superpowers-evals` commit.

Do not treat a `superpowers-evals` merge as fully propagated until that parent
submodule bump PR exists.

---

Security reporting → [SECURITY.md](SECURITY.md).
