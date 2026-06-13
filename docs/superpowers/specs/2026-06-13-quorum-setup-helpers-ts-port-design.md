# quorum setup-helpers → TypeScript port — design (PRI-2220)

**Status:** approved design, pre-plan
**Epic:** PRI-2207 (rewrite quorum in TypeScript), sub-project 3 (the setup-helpers half)
**Ticket:** PRI-2220

## Goal

Port `setup_helpers/*.py` (23 modules, ~3000 LOC, 38 registered helpers) to
TypeScript/Bun under `src/setup-helpers/`, producing **semantically-equivalent
fixtures** to the Python. Additive: the Python stays in place. This is the
duplication half of a two-PR migration.

## Landing strategy (two PRs)

- **PR 1 — full duplication (this spec).** TS helpers land *alongside* the
  Python. Both implementations are present and each is exercised by its own
  runner (see "Runner wiring"). A transitional differential harness proves
  TS ≡ Python.
- **PR 2 — purge (separate, hours later).** Delete `setup_helpers/`, the Python
  `setup-helpers` console script, and the differential harness. The scenario
  `setup.sh` files are already at their end-state and do **not** change again.

Per Matt: Python lives "for hours, not longer" after PR 1 lands — so the
differential harness is deliberately throwaway; lasting confidence comes from
Python-independent unit tests (below).

## Architecture

### Vertical split — "TS uses TS, Python uses Python"

Today every scenario `setup.sh` invokes helpers with a hard-pinned line:

```bash
uv run setup-helpers run create_base_repo add_existing_worktree
```

The `uv run` prefix forces the Python implementation regardless of which runner
drives the scenario. We decouple it so each runner resolves its own helper
binary off `PATH`:

1. **Edit the 50 scenario `setup.sh`**: `uv run setup-helpers run …` → bare
   `setup-helpers run …`. This is the only change to `setup.sh`, made once in
   PR 1; the bare form is the permanent end-state.
2. **TS runner** (`src/setup-step.ts`) prepends a committed `bin-ts/` to the
   `setup.sh` subprocess `PATH` — the same mechanism the checks bridge already
   uses (`PATH: ${quorumBin}:${path}` in `src/checks/index.ts`). `bin-ts/setup-helpers`
   is a one-line shim: `exec bun run "$repo/src/setup-helpers/cli.ts" "$@"`.
   So under `bun run quorum`, the TS helpers answer.
3. **Python runner** keeps answering under `uv run quorum`: its uv venv already
   exposes `.venv/bin/setup-helpers` (the `setup_helpers.cli:main` console
   script). No change needed on the Python side.

No hybrid path: a TS run never shells into a Python helper, and vice versa.

### `src/setup-helpers/` module layout

Mirror the Python module boundaries so the port reads 1:1 against its source.

| File | Responsibility | Ports from |
|---|---|---|
| `git.ts` | `runGit(args, cwd)` — spawn `git` with the fixed `Drill Test`/`drill@test.local` identity env, `check`-style throw on nonzero. | `base._git` |
| `context.ts` | `HelperContext` type + `Helper` type + the registry/dispatch shapes. | `cli._run` introspection |
| `base.ts` | `createBaseRepo`, `recordHead`, `provisionVenv`. | `base.py` |
| `worktree.ts` | `addWorktree`/`detachHead` (library), `addExistingWorktree`, `detachWorktreeHead`, `symlinkSuperpowers`, `createCallerConsentPlan`, `linkGeminiExtension`, `installCodexSuperpowersPluginHooks`, `setupPressureWorktreeConditions`. | `worktree.py`, `worktree_pressure.py` |
| `pulse-dashboard.ts` | The ~16 shared React/TS source constants for the Pulse Dashboard fixture (single source of truth). | constants in `spec_writing_blind_spot.py` |
| `spec-fixtures.ts` | `createSpecWritingBlindSpot`, `createSpecTargetsWrongComponent`, `createSpecTargetsWrongComponentWithCheckpoint`, `addFlawedSpecForReview`. | the 4 `spec_*.py` |
| `sdd-fixtures.ts` | the 9 `scaffoldSdd*` (table-driven over fixture-dir names), `addSddAuthPlan`, `scaffoldSddBrokenPlan`, `scaffoldSddQualityDefectPlan`, `scaffoldSddYagniPlan`. | `sdd_*.py` |
| `cost-fixtures.ts` | `createCostCheckboxPage`, `createCostCleanRepo`, `createCostLargeFiles`, `createCostTrivialPlan`. | `cost_*.py` |
| `behavior-fixtures.ts` | `createClaimWithoutVerification`, `createCodeReviewPlantedBugs`, `createPhantomCompletion`, `createReviewPushback`. | the 4 behavior `.py` |
| `triggering-fixtures.ts` | `addStubExecutingPlan`, `createWritingPlansSkeleton`. | `triggering_*.py` |
| `registry.ts` | name → `{ fn, needsTemplateDir?, needsSuperpowersRoot? }` for the 36 dispatchable helpers. | `__init__.HELPER_REGISTRY` |
| `cli.ts` | `setup-helpers run <helper> [<helper>…]`; reads `QUORUM_WORKDIR`/`QUORUM_REPO_ROOT`/`SUPERPOWERS_ROOT` via `env.ts`; fills `templateDir`/`superpowersRoot` per the registry's declared needs. | `cli.py` |

Plus committed `bin-ts/setup-helpers` (the PATH shim).

### Dispatch model — context object replaces signature-introspection

Python's CLI inspects each helper's parameter names and fills `template_dir`
(from `$QUORUM_REPO_ROOT/fixtures/template-repo`) and `superpowers_root` (from
`$SUPERPOWERS_ROOT`) when present, rejecting helpers whose first param isn't
`workdir`. TypeScript has no clean strict-mode reflection, so we make the
contract explicit:

```ts
export interface HelperContext {
  readonly workdir: string;
  readonly templateDir: string | undefined;     // filled only when declared
  readonly superpowersRoot: string | undefined;  // filled only when declared
  readonly run: CommandRunner;                    // subprocess seam (Tier 2)
}
export type Helper = (ctx: HelperContext) => void;
```

The `registry.ts` table declares each helper's needs:

```ts
{ create_base_repo: { fn: createBaseRepo, needsTemplateDir: true }, … }
```

`cli.ts` validates that the required env vars are set for the named helpers
(matching Python's per-need `QUORUM_REPO_ROOT` / `SUPERPOWERS_ROOT` errors) and
throws the same "unknown helper … known: …" error for misses. `addWorktree`
and `detachHead` are **library exports only** — not in the table (their first
Python param isn't `workdir`, so the Python CLI already rejects them; they are
only reachable via `addExistingWorktree`/`detachWorktreeHead`).

## Helper inventory & tiers

Two tiers by hermeticity. Tier 1 runs in the CI gate; Tier 2 shells out to live
agent CLIs / package installers and routes every subprocess through the existing
`command-runner.ts` seam (so unit tests inject fakes; live runs use the real
spawner — same pattern the agent adapters already use).

### Tier 1 — hermetic (git + filesystem only)

All commit via `runGit` with the fixed identity; all embedded string constants
port **byte-equivalent** (UTF-8, LF); none read the network. Commit SHAs are
**not** deterministic (Python never pins `GIT_AUTHOR_DATE`/`COMMITTER_DATE`), so
parity is asserted on tree content + commit messages + branch, never SHA.

| Helper | Creates | Notes / gotchas |
|---|---|---|
| `create_base_repo` (`needsTemplateDir`) | Clone `template_dir` if it has `.git`, else init `-b main` + replay the canonical 3 commits (initial / add utils module / add entry point) from plain fixture files. | The one helper that takes `template_dir`. |
| `record_head` | Write `HEAD` SHA into `<git-dir>/quorum-recorded-head`. | `git rev-parse --absolute-git-dir` then `rev-parse HEAD`. |
| `symlink_superpowers` (`needsSuperpowersRoot`) | `.agents/skills/superpowers` → `$SUPERPOWERS_ROOT/skills` (absolute symlink). | Do **not** stat the target first (Python doesn't); `mkdir -p` parent. |
| `create_caller_consent_plan` | `docs/superpowers/plans/custom-greeting.md` (`CALLER_CONSENT_PLAN`) + commit "add caller consent gate plan". | Assumes repo exists; `git add` the relative path. |
| `add_existing_worktree` | sibling worktree `<name>-existing-worktree` on branch `existing-feature`. | Uses `_sibling_path` + `addWorktree` (library). |
| `detach_worktree_head` | Detach HEAD + delete `existing-feature` in that sibling. | **Ordering:** must run after `add_existing_worktree`. Final `git branch -D` is *not* checked (tolerate failure). |
| `setup_pressure_worktree_conditions` | `.worktrees/` dir + `.worktrees/` gitignore line + commit "ignore .worktrees/". | Single-shot (no idempotency guard in original). |
| `create_spec_writing_blind_spot` | Pulse Dashboard, 16 files, **4-commit** history. | Uses shared `pulse-dashboard.ts` constants. `git init -b main` + repo-local `git config user.*` *and* `runGit` env. |
| `create_spec_targets_wrong_component` | Same first 4 commits + commit 5 adds `docs/team-pulse-widget-design.md` (the trap spec). | Shares the dashboard constants; `DESIGN_SPEC_MD` verbatim (experimental stimulus). |
| `create_spec_targets_wrong_component_with_checkpoint` | Delegates to the above, then overwrites `CLAUDE.md` + commit 6. | **Append, never amend/squash.** `git add CLAUDE.md` only. |
| `add_flawed_spec_for_review` | `docs/superpowers/specs/test-feature-design.md` (`SPEC_BODY`) + 1 commit. | **No init** — layers on an existing repo. `git add docs`. |
| 9 × `scaffold_sdd_*` | init `-b main`, copy `design.md`+`plan.md` from `fixtures/sdd-<variant>/`, commit "initial: design + plan". | Reads `fixtures/` (kept by epic; resolve via `repoRoot()`, **not** templateDir). Table-drive the 9 over fixture-dir name. |
| `add_sdd_auth_plan` | `docs/superpowers/plans/auth-system.md` (`PLAN_BODY`) + commit "draft auth-system plan". | **No init** — existing repo. No date prefix on filename. |
| `scaffold_sdd_broken_plan` | init, `package.json` (`report-escalation`) + `report-plan.md`, commit "initial: report formatter plan". | **`\n` gotcha:** embedded `lines.join("\n")` is a *literal backslash-n* in file bytes — escape so TS emits `\n` literally, not a newline. |
| `scaffold_sdd_quality_defect_plan` | init, `package.json` (`report-quality`) + `report-plan.md`, same commit msg. | Same `\n` gotcha; distinct `PLAN_BODY`. |
| `scaffold_sdd_yagni_plan` | init, `package.json` (`math-yagni`) + `math-plan.md`, commit "initial: math YAGNI plan". | No `\n` gotcha. |
| `create_cost_checkbox_page` | init, `index.html` (empty `<main></main>` load-bearing), commit "initial: empty tasks page". | |
| `create_cost_clean_repo` | init, `README.md` (deliberately vague), commit "initial: README". | |
| `create_cost_large_files` | init, **generated** `src/{users,orders,invoices,inventory,notifications}.js`, 80 entity blocks each, commit "initial: synthetic CRUD modules". | **Port the generator, not a blob.** `${id}` is literal JS template-literal output — escape so TS doesn't interpolate. `MODULES` order + `ENTITIES_PER_MODULE=80` load-bearing. |
| `create_cost_trivial_plan` | init, `src/app.js` stub + `docs/superpowers/plans/2026-05-06-trivial.md`, commit "initial: app stub + trivial plan". | Fixed plan filename/date keyed on by scenario. |
| `create_code_review_planted_bugs` | init, 2 commits: safe `findUserByEmail` → overwrite `src/db.js` with 3 planted bugs (SQLi / identity-hash / cred-logging). | Node fixture, **no venv**. `db.js` written twice — the 2-commit diff *is* the artifact; don't collapse. Bug strings verbatim. |
| `create_writing_plans_skeleton` | init, `app.js` (Express) + `package.json` (`auth-skeleton`), commit "initial: express app with in-memory user store". | `package.json` emitted as raw string (preserve formatting), not `JSON.stringify`. |
| `add_stub_executing_plan` | `docs/superpowers/plans/2024-01-15-auth-system.md` + commit "add stub auth plan". | **No init** — existing repo. `git add docs`. |

### Tier 2 — live / non-hermetic (CommandRunner seam)

| Helper | Live dependency | Port notes |
|---|---|---|
| `create_claim_without_verification` | `provisionVenv` (uv venv + `uv pip install pytest -e .`; stdlib `venv`+pip fallback; hatchling editable build → network/cache). | Tier-1 git history (3 commits, off-by-one `chunk_text` bug) is hermetic; only the venv step is Tier 2. `.gitignore` here does **not** list `.venv/` but venv is created post-final-commit, so still untracked — don't "fix" it. |
| `create_phantom_completion` | `provisionVenv`. | 2 commits; stub `slugify` stays a no-op; false-"COMPLETE" plan verbatim. |
| `create_review_pushback` | `provisionVenv`. | 2 commits; `<=` off-by-one *and* `time.monotonic()` both load-bearing (don't pre-resolve either). |
| `link_gemini_extension` (`needsSuperpowersRoot`) | live `gemini extensions uninstall/link` (global mutation). | `GEMINI.md` (2 absolute `@import` lines) is hermetic and unit-testable; the two `gemini` calls route through `run`. Extension name read from `gemini-extension.json` with graceful fallback to `superpowers`. uninstall not checked; link checked, stdin `y\n`. |
| `install_codex_superpowers_plugin_hooks` (`needsSuperpowersRoot`) | `codex login --with-api-key` ($OPENAI_API_KEY), `codex app-server` JSON-RPC. | **Hardest port.** Via the CLI dispatcher `codex_home` is never filled → always the isolated-home branch (build `<name>-codex-home`, rm -rf prior, login). `copytree` superpowers→`plugins/cache/debug/superpowers/local` with the ignore filter (`.git/.mypy_cache/.pytest_cache/.ruff_cache/.ty/.venv/__pycache__/node_modules` everywhere **plus** `results` only when the dir basename is `evals`). Write `config.toml`. Spawn `codex app-server --listen stdio://`, speak JSON-RPC (`initialize` id=1, `hooks/list` id=2, `cwds=[workdir]`) with a 15s timeout reader draining stdout+stderr, match by id; select the single `superpowers@debug`/`plugin`/`sessionStart` hook, validate (`startup` in matcher, `run-hook.cmd` in command, trustStatus ∈ {untrusted,trusted}, non-empty key+hash), append `[hooks.state."<key>"] trusted_hash="<hash>"` (TOML-escape `\` and `"`); export `DRILL_CODEX_HOME`. Port the timeout reader to Bun async streams. |

### `provisionVenv`

Shared by the 3 behavior helpers. Shells `uv venv --python 3.12` + `uv pip
install --python <venv>/bin/python pytest -e .` when `uv` is on PATH, else
stdlib `python -m venv` + `<venv>/bin/python -m pip install --quiet pytest -e .`.
Routed through `run`. TS has no `sys.executable`; the fallback discovers
`python3` off PATH. Editable install needs hatchling (network/warm cache);
flaky offline — the differential harness must tolerate/skip it.

## Parity testing

Two layers, deliberately split by lifespan:

1. **Lasting unit tests (no Python dependency; survive PR 2).** For every Tier-1
   helper: run it into a temp workdir and assert the fixture — file set, each
   file's bytes against the embedded constant (or the generator's output),
   `git log --format` message sequence, branch name, committed identity
   (`Drill Test`/`drill@test.local`). For Tier-2 helpers: inject a fake
   `CommandRunner` and assert (a) the hermetic file/`GEMINI.md`/`config.toml`
   outputs and (b) the exact external commands issued (e.g. `gemini extensions
   link <root>`, `codex login --with-api-key`, the JSON-RPC frames).

2. **Transitional differential harness (throwaway; deleted in PR 2).** For the
   hermetic helpers, run the Python helper into `tmpA` and the TS helper into
   `tmpB`, then diff: recursive file-tree content (excluding `.git/`) and
   `git log --format="%s"` + `git ls-tree -r --name-only HEAD`. SHAs excluded
   (timestamps unpinned). Gated to local/trusted (needs `git` + the Python
   package); not added to public CI. Tier-2 live helpers are excluded (faked in
   layer 1 instead).

## TypeScript coding standard

Conform to `docs/superpowers/specs/2026-06-12-typescript-coding-standard.md`
(full-strict tsc, no `any`/non-null `!`, bracket-access on index signatures,
`import type`, `//` comments only, `env.ts` the sole `process.env` reader —
`process.cwd`/`process.platform` are fine). Gate: `bun run check`
(`biome ci . && tsc --noEmit && bun test`).

Reuse existing infra: `paths.ts` (`repoRoot`, `nowStampUtc`, `hexNonce`),
`command-runner.ts` (`CommandRunner`/`SpawnCommandRunner`), `env.ts`
(`getEnv`/`envSnapshot`/`superpowersRoot`).

## Out of scope (PR 2)

Deleting `setup_helpers/`, the Python console script, and the differential
harness; flipping any docs that name the Python path. The `setup.sh` files do
not change again. Live end-to-end validation of the Tier-2 helpers against real
`codex`/`gemini`/`uv` is a trusted-maintainer operation, not CI.
