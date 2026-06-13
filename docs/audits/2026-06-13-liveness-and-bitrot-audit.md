# Codebase liveness & bitrot audit — running issues log

Started 2026-06-13. Scope chosen with Jesse: **whole dispatch surface**
(quorum/ + setup_helpers/ + bin/ + scenarios/ + coding-agents/), **audit-first**
(report before deleting/fixing), **cheap-tier execution + one live run per
adapter family**.

This is the running list of everything found that needs fixing. Status legend:
`OPEN` / `IN PROGRESS` / `FIXED` / `WONTFIX`. Sequencing decision: **capture
bitrot first**, then check-tool consolidation.

## Method / reusable artifacts

- `scripts/audit_liveness.py` — stdlib-only reference-counter over the
  string-dispatch surface (bin tools, helpers, quorum modules, agents). Counts
  references the way the runtime resolves them (shell words), because
  vulture/import-graphs can't see string dispatch. Re-run after future rewrites.
- Cheap tier: `uv run ruff check` / `ty check` / `quorum check` / `quorum list`
  / `pytest` / per-command `--help`. All green except one test (see B2).
- Live sweep logs: `/tmp/eval-audit-live/<agent>.log`; run dirs under `results/`.

## Live sweep result (one scenario per adapter family, 2026-06-13)

| Agent | Verdict | Cause |
|---|---|---|
| codex | pass | full pipeline OK |
| gemini | pass | full pipeline OK |
| copilot | pass | full pipeline OK |
| claude | indeterminate | no transcript at expected path — see **B1** |
| opencode | indeterminate | no session export — see **B3** |
| antigravity | indeterminate | agy plugin install path-doubling — see **B4** |
| pi | indeterminate | env not configured — see **B5** |

The harness core is sound (codex/gemini/copilot exercise drive→capture→check→
verdict end to end). Rot is localized, not systemic. Earlier "probably
systemic capture rot" hypothesis was **wrong** and is retracted.

---

## Bitrot (wired up but broken)

### B1 — claude transcript capture produces no transcript  [MITIGATED 2026-06-13: pin 2.1.175]
DECISION (Jesse): pin claude **2.1.175** for now rather than chase the new
layout — the older CLI still writes the legacy `projects/**/*.jsonl` the harness
globs. Root cause CONFIRMED (below): claude 2.1.x moved session transcripts to
`sessions/<uuid>/history.jsonl`. Independent corroboration: the `prudence`
harness (TS, bun) globs the same old `projects/**/*.jsonl` and dodges the bug
only by forcing `CLAUDE_CONFIG_DIR` + pinning an older claude — i.e. exactly the
pin-2.1.175 strategy. Proper fix (prefer `sessions/<uuid>/history.jsonl`, fall
back to legacy `projects/**`) deferred; revisit when we unpin or during the TS
capture port. Original investigation below.

---

The installed `claude` CLI completes the task but writes **no `*.jsonl`** under
`${CLAUDE_CONFIG_DIR}/projects/**` where `coding-agents/claude.yaml`
(`session_log_dir`/`session_log_glob`) looks. The project dir is created but
contains only an empty `memory/`. Result: every claude run → `indeterminate`,
and `coding-agent-tool-calls.jsonl` is empty (0 lines).
- Evidence: `results/00-quorum-smoke-hello-world-claude-20260613T175406Z-cdcb/`
- Impact: **blocks all claude verdicts** (the primary agent). gemini/codex/
  copilot capture fine, so this is claude-CLI-specific (likely the CLI changed
  where/whether it persists the session transcript).
- Fix: find the claude CLI's current transcript location/trigger; update
  `claude.yaml` capture config (and normalizer if the format moved).
- INVESTIGATION (2026-06-13, systematic-debugging, NOT yet confirmed):
  - Installed `claude` is **2.1.177**.
  - Isolated run config has `projects/<munged>/memory/` only — **no `*.jsonl`,
    no `sessions/` dir**. Subject wrote no transcript anywhere found at run
    time (17:54Z): not in isolated `projects/`, not in real `~/.claude`.
  - Real `~/.claude` now has a **new layout**: `sessions/<uuid>/history.jsonl`
    + `session.json` (claude 2.1.x). The harness still globs the OLD
    `${CLAUDE_CONFIG_DIR}/projects/**/*.jsonl`.
  - LEADING HYPOTHESIS (unconfirmed): claude 2.1.x changed session
    persistence — either moved to `sessions/<uuid>/history.jsonl`, or
    `--print` one-shot mode no longer writes a `projects/` rollout jsonl that
    the old harness relied on. codex/gemini/copilot use different capture
    paths (`_gemini_transcripts`, antigravity `brain/**/transcript.jsonl`),
    which is why they're unaffected — consistent with a claude-specific change.
  - DECISIVE TEST NOT YET RUN: launch claude 2.1.177 as the harness does
    (`--print`, isolated `CLAUDE_CONFIG_DIR`) on a trivial prompt; enumerate
    every file it creates; confirm where (if anywhere) the transcript lands.
    Paused pending the Python→TS migration discussion (capture fix is
    language-independent and still P0).

### B2 — antigravity stage-attribution test is FLAKY (env-sensitive)  [OPEN, P2]
`tests/quorum/test_runner.py::TestRunScenario::
test_antigravity_seed_runner_error_preserves_setup_stage` expects
`verdict.error.stage == "setup"`. CONFIRMED flaky on ambient `gauntlet`
provider state: first full run (clean env, no keys) → FAIL with stage
`"capture"` + "No LLM provider configured"; later full run (after live evals
this session likely persisted gauntlet provider config) → PASS. So it's not a
clean code regression — the test fails to isolate gauntlet's global provider
configuration. Fix: stub/clear gauntlet provider state in the test so stage
attribution is deterministic regardless of machine config.

### B3 — opencode session export not captured  [OPEN, P2]
`final indeterminate`: "no OpenCode session export appeared under isolated
`.quorum/session-exports`." opencode uses an export mechanism distinct from
the projects-dir agents. Either bitrot in the export step or env.
- Evidence: `results/opencode-superpowers-bootstrap-opencode-20260613T180320Z-5711/`

### B4 — antigravity `agy` plugin install path-doubling  [OPEN, P2]
`agy plugin install failed (exit 1)`: the install target path recursively
nests the run-dir path into itself
(`.../.gemini/config/plugins/superpowers/evals/results/<rundir>/coding-agent-config/.gemini/config/plugins/superpowers/evals/results/<rundir>...`).
A path-construction bug in the antigravity setup path. (agy is gemini-based —
writes `.gemini` config.)
- Evidence: `results/antigravity-superpowers-bootstrap-antigravity-20260613T175848Z-40d6/`

### B5 — pi requires unset env vars  [OPEN, P3 / config]
`coding-agents/pi.yaml` requires `PI_PROVIDER`, `PI_MODEL`, `PI_API_KEY`, none
present in the eval `.env`. Not code rot — pi can't be evaluated until these
are provisioned. Decide: provision pi creds, or mark pi as needs-config.

### B6 — gemini setup helper dead while its check is live  [OPEN, P2]
`link_gemini_extension` (the helper that *sets up* the gemini extension) has
**zero callers**, yet `gemini-extension-linked` (the check that asserts it
worked) is live. Setup path was rewritten out from under the assertion. NOTE:
gemini run still **passed**, so the current setup path works by another route —
confirm whether `link_gemini_extension` and/or the check are now both vestigial.

---

## Check-tool correctness (bin/)

### C1 — negative-assertion check tools false-pass on empty capture  [FIXED 2026-06-13]
FIX: added the `[ ! -s "$FILE" ]` empty/missing-capture guard to
`bin/tool-not-called` and `bin/skill-not-called` (mirrors the already-guarded
`implementation-tool-not-called`); empty capture now `record_fail`s + exits 1
instead of vacuously passing. TDD: 6 new tests in `test_trace_tools.py`
(`*_passes_when_absent`, `*_fails_when_present`, `*_fails_on_empty_capture` for
both tools) — watched the two empty-capture tests fail RED first, then green.
Full `test_trace_tools.py` (51) + ruff clean. Original finding below.

---

`tool-not-called` and `skill-not-called` pass condition is `COUNT == 0`, with
**no empty/missing-capture guard**. On an empty `coding-agent-tool-calls.jsonl`
(the B1 condition) they report **PASS** — proven by direct run. Their sibling
`implementation-tool-not-called` *is* guarded. So when capture is empty, any
scenario asserting "skill did NOT over-trigger" (the cost scenarios) **falsely
passes** — the one place the capture rot becomes a silent lie rather than a loud
failure. Positive assertions (`skill-called`, etc.) fail-loud and are safe.
Latent: the *missing*-file path throws `[: integer expression expected` (fails
closed, but sloppy).

### C2 — bin/ capture-family is copy-paste with divergent guards  [OPEN, P1]
12 tools read the tool-call capture; each re-implements load + `jq` check +
empty guard + count by hand. The shared seam `bin/_record` covers **output**
(JSON emit, ERR trap) but **not input**, so the error-prone input guarding was
left to copy-paste and diverged (C1 is the symptom). Root cause is a missing
abstraction, not 2 bad scripts.
- DECISION (Jesse): consolidate into a **single tool** with subcommands, e.g.
  `check-transcript skill-not-called <args>`; update callers. Jesse suggested
  **TypeScript**; OPEN QUESTION recorded below (TS vs Python — the parsing
  already exists in `quorum/normalizers.py` + `capture.py`, and the repo is
  Python). Resolve before building.

---

## Dead code (confirmed; small tail)

### D1 — `drill/` husk  [OPEN]
Untracked stale `*.cpython-312.pyc` (project pins 3.11), no source, not in git.
The previous runner, superseded by quorum. Remove disk cruft.

### D2 — `link_gemini_extension` helper genuinely dead  [OPEN]
Defined + registered in `HELPER_REGISTRY`, **zero** callers (no scenario, no
internal). Gemini-rewrite leftover. (See B6.)

### D3 — `detach_head` registry key dead (function live)  [OPEN]
`add_worktree` calls `detach_head()` internally, but no scenario dispatches the
registry key. Unregister the key; keep the function.

### D4 — `skill-before-tool-match` check tool dead  [OPEN]
Tested, but dispatched by **zero** scenarios — the unused "skill" sibling of
`tool-match-before-tool-match` (which is used 4×). Remove or wire up.

### D5 — `refresh-claude-home-skeleton`  [OPEN / low]
Manual ops helper: no test, no scenario dispatch. Not a check. Keep but
consider a smoke test.

---

## Documentation drift (liveness signal)

### E1 — architecture doc lists 10 quorum modules; 21 exist  [OPEN]
`CLAUDE.md` Architecture section omits the whole later cluster: `agy_creds`,
`agy_teardown`, `agy_watch`, `kimi`, `opencode_capture`, `economics`,
`run_all`, `setup_step`, `story_meta`.

### E2 — canonical actors list 4 coding-agents; 8 wired  [OPEN]
Adds antigravity, copilot, kimi, opencode beyond Claude/Codex/Gemini/Pi.

### E3 — "drill" vocabulary persists post-removal  [OPEN / low]
`drill@test.local`, "drill scenarios" remain after the drill package was
removed. Naming not reconciled.

### E4 — kimi un-runnable here  [OPEN / env]
`kimi` binary not installed; full config/scenario/check set present but cold.
Not in scope for the live sweep.

---

## TS migration (Python → TS, bun) — decisions & prudence findings

DECISIONS (Jesse): porting the whole harness to TS eventually; **runtime = bun**;
the consolidated check tool (C2) will be the TS pilot, dispatched as a single
tool with subcommands (`check-transcript skill-not-called <args>`), callers
updated. C1 hardening shipped in shell now to stop the bleeding (decoupled from
the rewrite).

`prudence` (`/Users/jesse/git/superpowers/prudence`) diligence — bun-native,
production-quality (418 tests, strict typecheck clean, ~20ms cold start →
fine for high-fanout check-tool spawning). It solves a *different* problem
(runs models in containers + judge panel), so it's a **design reference, not a
dependency**. Bottom line for us:
- **Reusable IR**: its canonical NDJSON event schema
  (`session` / `turn_start` / `tool_execution_start` / `tool_execution_end` /
  `turn_end` with a `usage` block) + the `toolCallId`-pairing logic in
  `src/runview/transcript.ts` + `ParsedTranscript` aggregation
  (`src/transcript/parse.ts`). Adopt as the shared IR for TS check-tools and the
  basis for "tool Y called / Y-before-Z / W-not-called".
- **Must build ourselves**: (i) an *on-disk*-layout normalizer — prudence's
  normalizers parse *streamed* `--output-format stream-json`, not the session
  files quorum reads; (ii) **all skill-invocation detection** — prudence has
  none (it runs Pi `--no-skills`); our `_skill_predicate.jq` logic has no
  counterpart there.
- **Not a B1 reference**: it shares our old-glob bug; confirms 2.1.x layout
  change.

OPEN: incremental (strangler-fig, leaf-first: bin/ → setup_helpers → capture/
normalizers → runner) vs big-bang. Recommendation on record: incremental — the
audit shows codex/gemini/copilot pass end-to-end, so the system mostly works;
don't big-bang-rewrite a working harness that's already been rewritten twice.
The 31 existing bin/ tests become the acceptance oracle for the TS port.

## Open questions for Jesse

1. **C2 toolchain: TypeScript vs Python** for the consolidated `check-transcript`
   tool. (See C2 note.) Resolve before building.
2. **B5/E4**: provision pi + kimi creds/binaries, or mark them needs-config?
