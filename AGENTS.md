# Superpowers Evals

Behavioral eval lab for superpowers. TypeScript, runs on Bun (≥1.3).

The active runner is the Gauntlet-backed **Quorum**. Code, CLI, paths, and
inline prose all use lowercase `quorum`.

## Commands

- **install**: `bun install`
- **test**: `bun test`
- **test single**: `bun test test/runner-unit.test.ts`
- **lint**: `bun run lint` (biome)
- **format**: `bun run format` (biome)
- **typecheck**: `bun run typecheck` (tsc --noEmit)
- **check (lint+typecheck+test)**: `bun run check`
- **validate scenarios**: `bun run quorum check`
- **run scenario**: `bun run quorum run scenarios/<name> --coding-agent <claude|codex>`
- **list scenarios**: `bun run quorum list`
- **scaffold scenario**: `bun run quorum new <name>`
- **show verdict**: `bun run quorum show [<target>]`

## Architecture

- `src/runner/` — per-run orchestration: setup, pre-checks, Gauntlet drive, capture, post-checks, verdict.
- `src/checks/` — sources `prelude.sh` (the bare-verb DSL: one shell function per check verb delegating to the TS CLIs) then `checks.sh`, runs `pre()`/`post()`, collects structured check records.
- `src/composer.ts` — composes Gauntlet-Agent verdict + deterministic checks into `pass | fail | indeterminate`.
- `src/contracts/` — zod schemas + types (`verdict.ts`, `agent-config.ts`, `batch.ts`, `economics.ts`, `gauntlet.ts`).
- `src/capture/` — session-log snapshot/diff + ATIF capture: normalizes each new log to an ATIF `Trajectory`, merges by timestamp, writes `trajectory.json`; `src/obol/` prices token usage.
- `src/atif/` + `src/normalize/` + `src/detect/` — ATIF v1.7 transcript (types/project/validate), the 8 per-Coding-Agent → ATIF normalizers, and the skill/implementation-path detectors.
- `src/check/` + `src/cli/check-tool.ts` + `src/cli/check-transcript.ts` — the typed check-tool dispatcher behind every bare-verb prelude function: `fs-verbs.ts` (file/git/env verbs + bootstrap checks), `transcript-dispatch.ts` (13 trace verbs, shared with `check-transcript`), `dispatch.ts` (verb table + in-process `not`), `record.ts` (sole emitter). Each verb emits one record; the 127 crash-band is preserved. `src/checks/prelude.sh` defines one shell function per verb (vocabulary from `list-check-verbs.ts`) execing `check-tool.ts <verb>`.
- `src/agents/` — per-Coding-Agent provisioning adapters over the `command-runner.ts` seam.
- `src/scaffold.ts` — `quorum new` / `quorum check` implementation.
- `src/cli/` — the `quorum` CLI; `src/run-all/` the batch matrix driver; `src/scheduler/` the concurrency dispatcher; `src/dashboard/` the web matrix.
- `src/checks/prelude.sh` — the bare-verb DSL (no check LOGIC): one shell function per check verb delegating to `check-tool.ts <verb>`, plus `not`, `check-transcript`, and `setup-helpers` functions. Sourced before `checks.sh` (`runPhase`) and before `setup.sh` (via `BASH_ENV`); no `bin/` on `PATH`. Operator scripts live in `scripts/`.
- `coding-agents/<name>.yaml` — per-Coding-Agent CLI config.
- `coding-agents/<name>-context/HOWTO.md` — instructions copied into Gauntlet-Agent context.
- `coding-agents/<name>-home-skeleton/` — seeded into the agent's config dir under the per-run throwaway `$HOME` (e.g. `<runDir>/home/.claude` / `<runDir>/home/.codex`).
- `scenarios/*/` — active scenarios, one directory each.
- `src/setup-helpers/` — fixture creators (CLI: `setup-helpers run <helper>`).
- `fixtures/` — static fixture repos (e.g. `template-repo/`).

## Scenario Conventions

- A quorum scenario is a directory under `scenarios/<name>/`.
- Required files: `story.md`, `setup.sh`, `checks.sh`.
- `story.md` briefs the Gauntlet-Agent and includes acceptance criteria.
- `setup.sh` builds the fixture using `$QUORUM_WORKDIR`; prefer
  `setup-helpers run <helper>` (a prelude function, sourced via `BASH_ENV`) over inline scripting.
- `checks.sh` contains exactly `pre()` and `post()` function definitions and no
  top-level executable statements.
- `checks.sh` should not have the executable bit set.
- Check verbs run from the fixture workdir as shell functions defined by the
  sourced `src/checks/prelude.sh` (no `bin/` on `PATH`).
- Post-checks that need sibling run artifacts can use `$QUORUM_RUN_DIR`.
- Use the top-of-file `# coding-agents: <csv>` directive to restrict a scenario
  to specific Coding-Agents.
- Use `requires-tool <name>` in `pre()` when a scenario depends on a local
  toolchain such as `go` or `npm`.

## Verdict Model

quorum verdicts are three-valued:

- `pass` — Gauntlet-Agent passed and all post-checks passed.
- `fail` — Gauntlet-Agent failed or a post-check failed.
- `indeterminate` — setup/pre-check/capture/quorum failure, Gauntlet
  `investigate`, or empty trace when trace checks are present.

Triaging a non-passing quorum run starts with `bun run quorum show [<target>]`
and `docs/superpowers/skills/triaging-a-failing-eval.md`.

## Safety

Static/unit checks are safe for CI:

```
bun run check          # biome + tsc + bun test
bun run quorum check   # scenario validation
```

Live evals are trusted-maintainer operations only. They launch agent CLIs in
permissive modes and can capture sensitive transcripts, tool calls, filesystem
state, and token data. Do not add live `quorum run ...` invocations, API keys,
or dangerous-mode agent launches to public CI.

## Required Env For Live Evals

```
ANTHROPIC_API_KEY=sk-...
OPENAI_API_KEY=sk-...
```

When this repo is checked out as `superpowers/evals`, quorum defaults
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
