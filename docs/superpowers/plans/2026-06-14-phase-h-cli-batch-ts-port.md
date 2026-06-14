# Phase H — port the CLI + batch driver to TS Implementation Plan

> Strategy spec; author executable detail after Phase G (the TS runner) exists. Gated: this flips the live `quorum` entry point fully to TS.

**Goal:** Port `quorum/cli.py` (357) + `quorum/run_all.py` (867) to TS/bun so the `quorum` command is TS end-to-end, then retire the Python CLI.

**Prerequisite:** Phase G (TS runner). H wraps it.

## CLI (`cli.py` → `ts/src/cli/quorum.ts`)
The `quorum` command group with subcommands `run`, `list`, `new`, `check`, `show`, `run-all` (read `cli.py` for each command's args/options). Implement with a minimal CLI lib (commander or yargs — one dep) or hand-rolled arg parsing (keep deps minimal). Each subcommand delegates to the already-ported TS:
- `run` → the TS runner (Phase G)
- `list`/`new`/`check` → TS `scaffold` (Phase B)
- `show` → TS `show` (Phase B)
- `run-all` → TS run_all (below)
Make `bin/quorum` (or the package `bin`) point at it. **Note:** CI's `uv run quorum check` and the dev workflow call `quorum` — flip those to the bun entry point and verify CI stays green.

## Batch driver (`run_all.py` → `ts/src/quorum/run-all.ts`)
Port `build_matrix` (scenario × agent matrix, `# coding-agents:` directive + `status: draft` filtering, per-agent max-concurrency), `invoke_child` (spawn a child `quorum run`), the batch dir allocation + header, the kimi batch preflight, and the concurrency runner (bun async with the per-agent concurrency caps). Parity-lock with `test_run_all.py` + `test_run_all_e2e.py`.

## Flip + retire
- Parity: a batch run via the TS CLI vs the Python CLI produces equivalent verdicts/matrix.
- Delete `cli.py` + `run_all.py`; update `pyproject.toml` `[project.scripts]` / the `quorum` entry; update CI + CLAUDE.md commands to the bun entry.
- Gated on Jesse's review (flips the live CLI + CI).

## Note
After H, the only Python left is `setup_helpers/` (Phase I) — at which point the harness is TS end-to-end (modulo the shell `checks.sh`/`setup.sh` scenario files + the external gauntlet + agent CLIs, which stay subprocess boundaries by design).
