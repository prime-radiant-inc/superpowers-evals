# Migration Notes

Tracks decisions, deferrals, and skipped scenarios during the Drill→Gauntlet
migration. Reviewed before Phase 3 decommission.

## Phase 1 deferrals

- **Token-cost wiring.** `harness/token_usage.py` is lifted from Drill but
  the runner doesn't yet call it. The three Phase 1 scenarios don't need
  cost data. Wire when the first cost-* scenario ports (Phase 2).
- **`setup.sh` shell-out latency.** Each scenario's `setup.sh` invokes
  `uv run python -c "..."` to call `setup_helpers/`, costing ~600ms per run.
  Acceptable for 3-scenario manual Phase 1. Promote to a `setup_helpers run
  <name>` CLI in Phase 2 when sweep-N runs make it visible.
- **PATH inheritance in assertions.** Phase 1 is not a CI workload. Document
  required tooling (jq, git, python) in the harness README before any CI
  integration.

## Phase 1 first-run findings (2026-05-18)

First parity attempt on `triggering-writing-plans` surfaced three real bugs the test suite missed because every test used `tmp_path` (always absolute) and `unittest.mock.patch` for the gauntlet subprocess:

1. **Relative scenario_dir broke setup.sh subprocess** — `subprocess.run([str(p)], cwd=X)` resolves relative `p` against `X`, not the harness's cwd. Fixed: CLI resolves every path to absolute at the boundary. Regression test added in `test_cli.py`.
2. **Claude session-log glob was stale** — `**/session-*.jsonl` matched nothing because current claude writes `<UUIDv4>.jsonl`. Drill's pattern was outdated. Fixed: glob is now `**/*.jsonl` in `harness/targets/claude.yaml`.
3. **tmux strips arbitrary env vars from new sessions** — `HARNESS_AGENT_CWD` and `SUPERPOWERS_ROOT` exported by the harness never reached the QA agent's bash. The QA agent ran `cd "$HARNESS_AGENT_CWD"` against an empty value (no-op), so claude launched in gauntlet's scratch dir. Fixed: runner templates HOWTO files at runtime, substituting the placeholders with resolved absolute paths.

The deeper Gauntlet-side fix for #3 is to have the TUI adapter pass `tmux new-session -e VAR=value` for each env var (or accept an allowlist). File upstream when convenient; current harness workaround works without Gauntlet changes.

### #3 root cause resolved (2026-05-20)

The "tmux strips env vars" framing in #3 was incomplete. The real
mechanism: `tmux new-session` attaches to an already-running shared
tmux server, and the new session inherits the *server's* environment,
not the calling process's. When the server was started by some
unrelated process, no per-run var reaches the agent. This bit Drill
hard once `CLAUDE_CONFIG_DIR` isolation landed (user plugins like
Bobiverse leaked in; logs written outside Drill's view) and then
`ANTHROPIC_API_KEY` (agent booted unauthenticated) — same root cause
in Harness via Gauntlet's TUI adapter.

Fixed properly in both:
- **Drill** — each `TmuxSession` runs on a private `-L <socket>`
  server, started by Drill so it inherits Drill's full environment.
- **Gauntlet** — same change in the TUI adapter (branch
  `matt/tui-private-tmux-server` in the gauntlet repo). A private
  server propagates *everything* with no enumeration — strictly better
  than the `-e VAR=value` allowlist idea above.

Consequence: the HOWTO runtime-templating workaround for
`$HARNESS_AGENT_CWD` / `$SUPERPOWERS_ROOT` / `$CLAUDE_CONFIG_DIR` is
now redundant — those vars reach the QA agent's shell by inheritance
once the Gauntlet branch is merged. The templating is harmless and
left in place; simplifying it (and the substitution map in
`runner._populate_context_dir`) is a deferred cleanup, not urgent.

## Code-review follow-ups from Phase 1 build

Logged here for Phase 2 attention; none block Phase 1 ship.

- ~~**I-2 (Faraday on T10): stale lockfile recovery.**~~ **Resolved
  2026-05-19.** The lockfile was guarding a shared `~/.claude/projects`
  log root against cross-run snapshot/diff contamination. The
  CLAUDE_CONFIG_DIR / CODEX_HOME isolation gives each run its own
  config-dir tree (under `<run-dir>/agent-config/`), so the lock no
  longer has a target to protect. Dropped along with `_single_run_lock`.
- **I-3 (Faraday on T10): same-second run dir collision.** `run_dir =
  out_root / f"{scenario}-{target}-{timestamp}"` with second granularity
  and `exist_ok=True`. Two runs within the same second would silently share
  a dir and trample each other's `verdict.json`. Phase 1's lockfile blocks
  the intra-target case but not different scenarios with shared names. Add
  a short random suffix or set `exist_ok=False` in a polish pass.
- **M-4/M-5 (Faraday): test coverage gaps in runner helpers** —
  `_resolve_launch_cwd` doesn't have a test for the "sentinel points at
  nonexistent path" raise, and `_gauntlet_status_from_run_dir` doesn't
  have a test for malformed JSON / unexpected status string. Both raise
  cleanly; tests would lock in current behavior.

## Phase 1 parity outcomes

To be filled in by the manual parity runs (Tasks 18–20).
