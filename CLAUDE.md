# Superpowers Evals

Behavioral eval lab for superpowers. TypeScript, runs on Bun (≥1.3).

The active runner is the Gauntlet-backed **Quorum**. Code, CLI, paths, and
inline prose all use lowercase `quorum`; the capitalized form `Quorum` appears
in headings and the actor table.

## Canonical Actors

Keep the actors straight; confusing them is the most common triage error.
These names are used everywhere: docs, CLI output, code, filenames, and commit
messages.

| Actor | What it is | Where it lives / its files |
|---|---|---|
| **Gauntlet** | General-purpose QA framework; the `gauntlet` CLI. A black-box tester. | repo `~/Code/prime/gauntlet`; on `PATH` as `gauntlet` |
| **Gauntlet-Agent** | The LLM inside Gauntlet that drives the Coding-Agent and self-grades against the story's ACs. | model e.g. `claude-sonnet-4-6`; event stream -> `<run>/gauntlet-agent/results/<runId>/run.jsonl`; verdict -> `result.{json,md}` |
| **Coding-Agent** | The agent under test. Instances: **Claude**, **Claude Haiku**, **Claude Sonnet**, **Codex**, **Antigravity**, **Gemini**, **Kimi**, **OpenCode**, **Pi**, and **Copilot**. | session log -> under the per-run throwaway `$HOME` (`<run>/home/<agent-config-subdir>/...`, e.g. `.claude`/`.codex`); files it writes -> `<run>/coding-agent-workdir/` |
| **Quorum** | The TypeScript wrapper. Owns setup, Coding-Agent adaptation, deterministic checks, and final verdict composition. | repo `superpowers-evals/src/`; `<run>/verdict.json` |

A run involves two LLMs: the **Gauntlet-Agent** (QA tester) and the
**Coding-Agent** (subject). Separate models, logs, and token costs.

## Commands

- **install**: `bun install`
- **test**: `bun test`
- **test single**: `bun test test/runner-unit.test.ts`
- **lint**: `bun run lint` (biome)
- **format**: `bun run format` (biome)
- **typecheck**: `bun run typecheck` (tsc --noEmit)
- **check (lint+typecheck+test)**: `bun run check`
- **validate scenarios**: `bun run quorum check`
- **run scenario**: `bun run quorum run scenarios/<name> --coding-agent <agent>`
- **list scenarios**: `bun run quorum list`
- **scaffold scenario**: `bun run quorum new <name>`
- **show verdict**: `bun run quorum show [<target>]`
- **run all**: `bun run quorum run-all [--coding-agents X,Y] [--jobs N]`
- **show batch**: `bun run quorum show <batch-id>` (matrix view)
- **dashboard**: `bun run quorum dashboard [--port N]` (web matrix: results, launch, live progress)

Per-coding-agent config: `coding-agents/<name>.yaml`. Per-coding-agent HOWTO:
`coding-agents/<name>-context/HOWTO.md`. Each agent seeds its config under the
per-run throwaway `$HOME` (e.g. `<runDir>/home/.claude` /
`<runDir>/home/.codex`) at provision time; no committed home skeleton ships.
Spec: `docs/superpowers/specs/2026-05-22-harness-model-design.md`.

## Architecture

- `src/runner/` — per-run orchestration: setup, pre-checks, Gauntlet drive, capture, post-checks, verdict (`index.ts`); `context.ts`, `phase.ts`, `errors.ts` (staged `RunError`), `stopped.ts`.
- `src/checks/` — sources `prelude.sh` (the bare-verb DSL: one shell function per FS check verb, plus `not`/`check-transcript`/`setup-helpers`, each delegating to the TS CLIs) then `checks.sh`, runs `pre()`/`post()`, collects structured check records (the verb functions emit them to `QUORUM_RECORD_SINK`).
- `src/composer.ts` — composes Gauntlet-Agent verdict + deterministic checks into `pass | fail | indeterminate`.
- `src/contracts/` — zod schemas + types: `verdict.ts` (the `verdict.json` shape), `agent-config.ts`, `batch.ts`, `economics.ts`, `gauntlet.ts`.
- `src/capture/` — session-log snapshot/diff + ATIF capture (`index.ts`): normalizes each new log to an ATIF `Trajectory`, merges them by step timestamp, writes `trajectory.json`, then `captureTokenUsage` prices that trajectory via obol's `"atif"` dialect into the frozen `coding-agent-token-usage.json` (kimi byte-count + wall-clock duration are the only raw-log reads — never tokens); per-backend cwd filtering (`cwd-filter.ts`).
- `src/obol/` — obol cost estimation: `estimateTrajectory` prices the coding-agent ATIF `trajectory.json` (obol `"atif"` dialect, honoring embedded `cost_usd` else its rate tables), `estimateUsageSidecar` prices the gauntlet usage sidecar (obol `"obol"` dialect); `mergeEstimates` folds obol `CostEstimate`s into the `TokenUsage` shape.
- `src/economics.ts` — assembles the economics block carried in the verdict.
- `src/atif/` — ATIF v1.7 canonical transcript: `types.ts` (the `Trajectory` shape), `project.ts` (`flattenToolCalls` → `{tool,args}` view), `validate.ts`.
- `src/normalize/` — per-Coding-Agent session-log → ATIF `Trajectory` normalizers.
- `src/detect/` — skill-invocation and implementation-path detectors used by the transcript checks.
- `src/check/` + `src/cli/check-tool.ts` + `src/cli/check-transcript.ts` — the typed check-tool dispatcher behind every bare-verb prelude function. `fs-verbs.ts` holds the filesystem/git/env verbs (`file-exists`, `file-contains`, `command-succeeds`, `git-*`, `assert-checkout-clean`, `requires-tool`, `files-exist`) plus the 6 per-harness bootstrap checks (`*-installed`/hook/extension, incl. the ported kimi-jq and codex-toml logic); `transcript-dispatch.ts` runs the 13 trace verbs (`verbs.ts`) and is shared by `check-transcript.ts`; `dispatch.ts` is the verb table + the in-process `negate` (`not`); `record.ts` is the sole record emitter. `check-tool.ts` owns the 127 crash-band exit discipline; every verb emits one `{check,args,negated,passed,detail}` record. `src/checks/prelude.sh` defines one shell function per verb (its vocabulary read from `Object.keys(FS_VERBS)` via `src/cli/list-check-verbs.ts`, so it can't drift) that execs `check-tool.ts <verb>`.
- `src/agents/` — per-Coding-Agent provisioning adapters (one per agent) over the `command-runner.ts` subprocess seam.
- `src/scaffold.ts` — `quorum new` / `quorum check` implementation.
- `src/scheduler/` — central concurrency dispatcher (global slot cap, per-harness cap + launch spacing) over an injectable `clock.ts`; shared by `run-all` and the dashboard.
- `src/cli/` — the `quorum` CLI (`run`/`list`/`new`/`check`/`show`/`run-all`/`dashboard`) + verdict/batch renderers; entry `index.ts` (`bun run quorum`).
- `src/run-all/` — batch matrix driver (scenario × agent), batch dir allocation.
- `src/dashboard/` — web dashboard: `scan.ts`/`view.ts` (read side over `results/`), `templates.ts` (typed HTML renderers; `cellHtml` is the single source for first paint + SSE swaps), `event-bus.ts` (bounded SSE fan-out), `orchestrator.ts` (one-session-at-a-time launch/stop over the scheduler, pid-tracked SIGINT), `server.ts` (`Bun.serve` routes + ~1s scanner loop), `index.ts` (`startDashboard`).
- `src/setup-helpers/` — fixture creators. Each helper takes a uniform `HelperContext` (`context.ts`); `registry.ts` maps the dispatchable snake_case names to entries declaring `needsTemplateDir`/`needsSuperpowersRoot`, and `KNOWN_HELPER_NAMES` is the single validation set `quorum check` uses. `cli.ts` is the `setup-helpers run <helper>` entrypoint. Tier-1 helpers (git + filesystem: `base.ts`, `fs.ts`, `git.ts`, `spec-fixtures.ts`, `sdd-fixtures.ts`, `cost-fixtures.ts`, `behavior-fixtures.ts`, `triggering-fixtures.ts`, the non-codex/gemini `worktree.ts` parts, shared `pulse-dashboard.ts` constants) are hermetic and unit-tested directly; Tier-2 helpers (`provisionVenv`, `linkGeminiExtension`, `installCodexSuperpowersPluginHooks` + its `codex-app-server.ts` JSON-RPC client) route subprocess calls through `agents/command-runner.ts` so tests inject fakes. `setup.sh`'s bare `setup-helpers run …` resolves to TS via the `setup-helpers` function in the sourced `src/checks/prelude.sh`, which `src/setup-step.ts` sources through `BASH_ENV` before running `setup.sh`.
- `src/checks/prelude.sh` — the bare-verb DSL (no check LOGIC): one shell function per check verb delegating to `check-tool.ts <verb>`, plus the `not`, `check-transcript`, and `setup-helpers` functions. Sourced before `checks.sh` (`runPhase`) and before `setup.sh` (via `BASH_ENV`); there is no `bin/` on `PATH`.
- `scenarios/` — active scenarios, one directory each.
- `coding-agents/` — per-agent YAML and context HOWTOs (see "Per-coding-agent" above).

## Scenario Conventions

Full authoring guide: `docs/scenario-authoring.md`
(anatomy, story/AC craft, the setup-helper catalog, the check-verb vocabulary,
and the fail-vs-indeterminate triage tree).

- A quorum scenario is `scenarios/<name>/{story.md,setup.sh,checks.sh}`.
- Fixture plans for skill-execution scenarios should be generated by the
  skill under test, not hand-written: hand-authored prose plans execute
  ~2× costlier than real writing-plans output and overstate baseline costs
  (methodology correction, `docs/experiments/2026-06-10-sdd-cost-experiments.md`).
  The `*-elicited` scenarios are the realistic fixtures; keep legacy
  hand-plan scenarios only for longitudinal comparability.
- `story.md` briefs the Gauntlet-Agent and includes evidence-demanding ACs.
- `setup.sh` builds the fixture using `$QUORUM_WORKDIR`; prefer
  `setup-helpers run <helper>` (a prelude function, sourced via `BASH_ENV`).
- `checks.sh` contains only `pre()` and `post()` function definitions.
- `checks.sh` should not have the executable bit set.
- Check verbs run from the fixture workdir as shell functions defined by the
  sourced `src/checks/prelude.sh` (no `bin/` on `PATH`).
- Post-checks that need sibling run artifacts can use `$QUORUM_RUN_DIR`.
- Use `# coding-agents: <csv>` to restrict a scenario to specific agents.
- Use `requires-tool <name>` in `pre()` for local toolchain dependencies.

## Triage

Triaging a non-passing quorum run starts with:

```
bun run quorum show [<target>]
```

Then use `docs/superpowers/skills/triaging-a-failing-eval.md` for the
attribution atlas.

## Safe Checks

These are safe for CI and routine PRs:

```
bun run check          # biome + tsc + bun test
bun run quorum check   # scenario validation
```

Live `quorum run ...` evals are trusted-maintainer operations only. They
launch agent CLIs in permissive modes and can capture sensitive transcripts,
tool calls, filesystem state, and token data. Do not add live evals, API keys,
or dangerous-mode launches to public CI.

## Required Env For Live Evals

```
ANTHROPIC_API_KEY=sk-...
OPENAI_API_KEY=sk-...
```

Agent-specific live credentials are documented in `README.md`. The common
cases are Anthropic for Claude variants, OpenAI/provider keys for OpenCode,
Gemini API key or OAuth, Kimi API key or OAuth, Pi API key or OAuth, Copilot
GitHub auth, and local Codex subscription auth.

quorum does **not** auto-discover `SUPERPOWERS_ROOT` — export it explicitly to
your `superpowers` checkout (the directory that contains this `evals/` tree).
Provisioning and every `needsSuperpowersRoot` setup-helper read it and fail fast
if it is unset:

```
export SUPERPOWERS_ROOT=/path/to/superpowers
```

## Experiment Log

Every experiment campaign gets a dated entry in `docs/experiments/` —
hypotheses, configs, run pointers, and verdicts, with **negative results
recorded at equal billing to wins**. Before proposing an optimization or
behavioral change, check the log: it exists so disproofs don't get
re-purchased. Specs in the parent repo cite these entries rather than being
their only copy.

## Parent Superpowers Submodule

`superpowers-evals` is consumed by `superpowers` as the `evals` submodule.
After any PR merges to `main` here, open a follow-up PR against the parent
`superpowers` repo targeting `dev` that bumps the `evals` submodule pointer to
the merged `superpowers-evals` commit.

Do not treat a `superpowers-evals` merge as fully propagated until that parent
submodule bump PR exists.
