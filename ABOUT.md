# superpowers-evals

> Behavioral eval lab (Quorum) for Superpowers that drives real coding-agent CLIs through a Gauntlet QA agent and grades them on workflow compliance.

**Family:** superpowers · **Type:** tool · **Lifecycle:** experimental · **Owner:** obra, arittr, mhat

## What it does
Quorum drives real coding-agent CLIs (Claude, Codex, Antigravity, Gemini, Hermes, Kimi, OpenCode, Pi, Copilot, serf) through a Gauntlet QA agent and grades them against scenario acceptance criteria plus deterministic post-checks. It is an eval lab for workflow compliance — skill triggering, worktree behavior, subagent coordination, verification reflexes, review quality, cost-shaping — not a generic benchmark. Static/unit checks are CI-safe; live evals are trusted-maintainer operations that launch agent CLIs in permissive modes. Ships two Bun CLIs: `quorum` (the runner) and `evals-appliance` (the shared remote eval appliance), plus a results dashboard package.

## How it fits
- Depends on: [gauntlet](https://github.com/prime-radiant-inc/gauntlet) — quorum shells out to the gauntlet CLI as the QA grader (`src/runner/index.ts` buildGauntletArgv); [obol](https://github.com/prime-radiant-inc/obol) — package dependency `@primeradianthq/obol` for token-usage/cost accounting (package.json, `src/obol/index.ts`); [serf](https://github.com/prime-radiant-inc/serf) — serf is one of the coding-agent CLIs it provisions and launches as an eval subject (`src/agents/serf.ts`).
- Evaluates: [superpowers-private](https://github.com/prime-radiant-inc/superpowers-private) — Superpowers is the system under test; runs stage the local Superpowers checkout (SUPERPOWERS_ROOT) under an isolated home and grade workflow compliance.
- Used by: —
- External: Anthropic, OpenAI Codex, Antigravity, Gemini, Hermes, Kimi, OpenCode, Pi, Copilot agent CLIs (launched as eval subjects); OpenRouter.

## Runtime & data
- Runs: Bun/TypeScript CLIs (`quorum`, `evals-appliance`) run locally by trusted maintainers or on the Terminus-managed evals appliance (containerized runs); GitHub Actions for static/unit checks only.
- Data in: Eval scenarios, acceptance criteria, Superpowers checkout under test, agent credentials.
- Data out: Grades, transcripts, tool-call logs, filesystem-state captures, run economics, dashboard views under results/.

<!-- Maintained by the maintaining-project-map skill. Do not hand-edit; regenerated. -->
