# Design: Collapsing the `bin/` check vocabulary into one typed dispatcher

> Status: proposal (2026-06-15), read-only study. Recommendation: generalize the existing `check-transcript` pattern — one `quorum check-tool <verb>` TS dispatcher behind one-line PATH shims — phased so every current scenario keeps working untouched. **Sequence AFTER the ATIF/parity waves land** (orthogonal, but touches the same `src/checks/`/`src/check/` files).

## 1. Inventory (`bin/`, 19 files, all bash except the one TS shim)

Three kinds: **check vocabulary** (emit a record, used in `checks.sh`), **infrastructure** (`_record`, `not`, `check-transcript`), one **maintenance** script (`refresh-claude-home-skeleton` — not a check, doesn't belong in `bin/`).

- Vocabulary (bash): `file-exists`, `file-contains`, `command-succeeds`, `git-repo`, `git-branch`, `git-clean`, `git-count`, `assert-checkout-clean`, `requires-tool`, + 6 single-scenario bootstrap checks (`antigravity-plugin-installed`, `copilot-plugin-installed`, `gemini-extension-linked`, `opencode-plugin-installed`, `kimi-plugin-installed` [104 lines of jq], `codex-native-hook-configured`).
- Infra: `_record` (sourced lib → JSON line to `$QUORUM_RECORD_SINK`, jq, ERR-trap fail), `not` (negation wrapper, jq), `check-transcript` (**4-line TS shim** → `src/cli/check-transcript.ts`, 13 trace verbs).
- **The precedent:** `check-transcript` already collapsed 13 bash trace tools into ONE typed, unit-tested TS dispatcher (`src/check/verbs.ts` pure `(calls,empty,args)=>{passed,detail}` fns). The other 13 checks are the un-migrated half.

Invocation: `src/checks/index.ts:runPhase` prepends `bin/` to PATH, sets `QUORUM_RECORD_SINK`, runs `bash -c "source checks.sh; <phase>"`; each tool appends one JSON line; `readRecords` parses via `SinkRecordSchema`.

## 2. The record protocol (must be preserved byte-for-byte)

- **Record shape** (`src/contracts/verdict.ts:27-35`): `{check, args[], negated, passed, detail|null, phase}`; `phase` injected by `runPhase`, not the tool. Two emitters agree byte-for-byte today: bash `_record` and TS `src/check/record.ts` (incl. `detail===''→null`).
- **Sink unset → record is a no-op** (deliberate; lets `not` suppress the inner record by unsetting the var).
- **Negation (`bin/not`) — 3 load-bearing rules:** (1) emits ONE record on the inner tool's behalf with `check=<inner>`, `negated:true`; (2) refuses to invert a MISSING tool (a typo'd `not file-exits` must not green-light); (3) refuses to invert a CRASH (126/127/≥128).
- **Broken-check / "no vacuous pass" convention (the spine):** crashes exit in the reserved band (126/127/≥128); `check-transcript` exits **127** on usage errors / unknown verbs / missing args / keyless matchers ON PURPOSE so an under-specified check can't vacuously pass or be inverted. Consumed by `runPhase`'s crash heuristic + the composer's `TRACE_PRIMITIVES` empty-capture gate.
- **`requires-tool`** (pre-phase): missing tool → pre fails → composer `indeterminate` (env-missing, not broken-check).

## 3. Author-facing surface (must not regress)

55 scenarios. Usage: `git-repo` 55×, `git-branch` 52×, `check-transcript` 92×, `file-exists` 94×, `file-contains` 34×, `command-succeeds` 29×, `not` 21×, `git-count` 17×, `requires-tool` 15×; the 6 bootstrap checks 1× each. The surface is **bare command words in a bash `pre()`/`post()`** composed with bash (`not X`, `requires-tool go`, `command-succeeds 'go test ./...'`). That ergonomic is the constraint.

## 4. Why it's "weird/gross"

1. **bash↔TS split down one concept** — `check-transcript` is typed/tested TS; the other 13 are bash. Two record emitters kept byte-identical by hand; the crash-band idea reimplemented in 4 places (`_record` ERR trap, `not`, `check-transcript.ts`, `runPhase`).
2. **bash 3.2 tax** (macOS) — `file-exists` hand-rolls globstar via `find`; `_record` dodges `[ -v ]`.
3. **Untested check LOGIC** — the sink protocol is integration-tested, but the bash branches (`file-exists` `**`, `git-count`'s 6 operators, `kimi-plugin-installed`'s 104 jq lines) have no unit tests, unlike every `check-transcript` verb.
4. **jq is a hidden runtime dep** of `_record`/`not`/`kimi-plugin-installed` in a "zero-dependency, Bun-standardized" repo.
5. **PATH coupling + executable-bit gotchas** (checks.sh must NOT be executable; tools must be).
6. **POSIX-only / no Windows** — all `#!/usr/bin/env bash` + `find`/`grep`/`git --porcelain`; no `run-hook.cmd`-style wrapper. `check-transcript` already runs cross-platform on Bun.
7. **Sprawl** — 6 near-identical `*-installed` boilerplate checks; a maintenance script polluting `bin/`.

## 5. Recommendation — Option A: generalize `check-transcript`, phased

`bin/` becomes ~13 four-line shims (like `bin/check-transcript` already is), each `exec bun run src/cli/check-tool.ts <verb> "$@"`. All check LOGIC moves to `src/check/` as pure verb functions; one `src/cli/check-tool.ts` dispatches, reusing `src/check/record.ts` (sole emitter — delete `_record`) and the 127 crash-band discipline. `not`/`requires-tool` become verbs (or `not` calls a TS `negate` importing the dispatch table — no subprocess, no jq). `command-succeeds` keeps a real `bash -c` shell-out inside TS.

- **Pros:** one emitter; jq gone; every branch unit-testable; bash-3.2/globstar footguns deleted; Windows-capable (Bun); the 4 near-identical `*-installed` checks collapse to one `files-exist <root> <rel...>` verb; crash-band/negation/empty-capture centralized. Matches the precedent the repo already chose.
- **Cons:** **per-shim Bun startup** (~tens of ms) — `git-repo`+`git-branch` run in every `pre()`; across `run-all` it's real but tiny vs a live LLM session. Mitigation: optional later `--batch` mode (one Bun process per phase). Measure before optimizing.

**Rejected:** Option B (declarative `checks.yaml`) — loses the bash flexibility 20 scenarios use (`command-succeeds 'go test ...'`); reinvents a DSL for negation/sequencing/escapes; rewrites all 55. Option C (keep bash, dedupe) — doesn't fix the split/testing/jq/Windows; hand-rolling JSON escaping in bash is more fragile than jq. Stopgap only.

## 6. Migration invariants (acceptance criteria)
- Emitted record JSON byte-identical; `SinkRecordSchema` parses unchanged.
- `not` keeps all 3 rules (one record, `check=<inner>`, non-invertible on missing-tool/crash).
- 127 crash band preserved for usage errors / unknown verbs / missing args / keyless matchers.
- `requires-tool` fail → `indeterminate`.
- `runPhase` crash heuristic + composer `TRACE_PRIMITIVES` empty-capture gate keep working (names unchanged → likely no composer change).

## 7. Phased plan (every phase leaves all 55 scenarios green)
1. Port pure checks: `git-*`, `file-exists`, `file-contains` → TS verbs + unit tests + a `runPhase` record-equality integration test vs the old bash output.
2. Port shell-out checks: `command-succeeds`, `assert-checkout-clean`, `requires-tool` (keep 500-byte truncation; keep fail→indeterminate).
3. Port `not` → in-process TS `negate` (no subprocess, no jq), preserving missing-tool/crash non-inversion.
4. Collapse the 6 bootstrap checks into one `files-exist <root> <rel...>` verb (+ port `kimi-plugin-installed` jq logic to TS, `codex-native-hook-configured` toml greps to TS regex).
5. Delete `_record`; relocate `refresh-claude-home-skeleton` out of `bin/` (e.g. `scripts/`); update `src/checks/index.ts` doc comment.
6. Optional: `--batch` entry if startup cost shows up in `run-all` timings (measure first; experiment-log discipline).

### Key files
`bin/` (`_record`, `not`, `check-transcript`, the vocabulary); `src/checks/index.ts` (`runPhase`, `SinkRecordSchema`, crash heuristic); `src/check/record.ts` + `src/check/verbs.ts`; `src/cli/check-transcript.ts` (the dispatcher precedent: 127 band, arity table); `src/contracts/verdict.ts:27-35`; `src/composer.ts` (broken/empty/negated consumers); `test/checks.test.ts` (sink integration; no per-tool bash-logic unit tests today).
