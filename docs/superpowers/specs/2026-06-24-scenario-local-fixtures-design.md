# Scenario-local fixtures — design

**Status:** proposed design, pre-plan
**Ticket:** (unassigned)

## Goal

Make a scenario directory self-contained: move each scenario's on-disk fixture
content out of the top-level `fixtures/` tree and into the scenario's own
directory, so adding a fixture-based scenario requires **zero TypeScript**. A new
SDD-style scenario becomes "drop `story.md`, `setup.sh`, `checks.sh`, and a
`fixtures/` folder in one directory" — no new helper function, no registry entry.

This replaces four near-identical bespoke scaffold helpers with one generic
helper, and removes the hidden coupling where a scenario's seed content lives in
a repo-global directory keyed by a name string that happens to match the
scenario.

## Background — what exists today

On-disk fixtures live in exactly two shapes under top-level `fixtures/`:

| Path | Scope | Read by |
|---|---|---|
| `fixtures/template-repo/` | **Shared** across many scenarios | `create_base_repo` via `templateDir` (`src/setup-helpers/cli.ts:42`) |
| `fixtures/sdd-go-fractals-{gpt55,opus48}/`, `fixtures/sdd-svelte-todo{,-opus48}/` | **Per-scenario**, 1:1 with the scenario of the same name | `scaffoldFromFixture()` (`src/setup-helpers/sdd-fixtures.ts:19`) |

Each per-scenario dir holds `design.md` + `plan.md`. Everything else
(auth/broken/quality/yagni/spec-constraint plans, cost/spec/behavior/triggering
fixtures) is **inline string constants** embedded in the TS helpers, not files.

The blocker for scenario-local fixtures: **a helper cannot see its own scenario
directory.** `HelperContext` (`src/setup-helpers/context.ts:8`) carries only
`workdir`, `templateDir`, `superpowersRoot`, `run`. `runSetup`
(`src/setup-step.ts:20`) knows `scenarioDir` but forwards only
`QUORUM_REPO_ROOT` + `QUORUM_WORKDIR` to the `setup.sh` subprocess.
`FIXTURES_DIR` is hardcoded to `repoRoot()/fixtures` (`sdd-fixtures.ts:14`).

The four target scenarios each have a trivial one-line `setup.sh`
(`setup-helpers run scaffold_sdd_*`) and check only `file-exists design.md` /
`file-exists plan.md` in `pre()`. No check asserts the seed commit message; the
`git-count commits gte 4` post-check is about the agent's later work, not the
seed. The two go-fractals `design.md` files are byte-identical.

## Design

### Keystone: a third "declared need"

The fix reuses the existing declared-needs mechanism rather than inventing a new
one. Today `RegistryEntry` declares `needsTemplateDir` / `needsSuperpowersRoot`,
and `cli.ts` fills the corresponding `HelperContext` field from an env var,
throwing if it is unset. Add one more instance of that exact pattern:

1. **`src/setup-step.ts`** — forward the scenario directory it already holds as
   `QUORUM_SCENARIO_DIR` in the `setup.sh` subprocess env (alongside
   `QUORUM_WORKDIR` / `QUORUM_REPO_ROOT`). This also makes it available to raw
   `setup.sh` bodies, parallel to the existing `QUORUM_*` family.
2. **`src/setup-helpers/registry.ts`** — `RegistryEntry` gains
   `needsScenarioDir?: boolean`.
3. **`src/setup-helpers/context.ts`** — `HelperContext` gains
   `scenarioDir: string | undefined`.
4. **`src/setup-helpers/cli.ts`** — `HelperEnv` gains `scenarioDir`; `main()`
   reads `QUORUM_SCENARIO_DIR`; `runHelpers` fills `scenarioDir` for a
   `needsScenarioDir` helper and throws `'setup-helpers: QUORUM_SCENARIO_DIR is
   not set'` when absent — a line-for-line mirror of the existing
   `templateDir` / `QUORUM_REPO_ROOT` guard.

The result is a clean symmetry: `templateDir` is the **shared** template path;
`scenarioDir` is the per-scenario root whose `fixtures/` is the **per-scenario**
template.

### One generic helper

Add `init_repo_from_fixtures` (`needsScenarioDir: true`), replacing the four
`scaffoldSdd*` functions:

1. `ensureWorkdir`, `git init -b main`, identity config (the existing
   `scaffoldFromFixture` preamble).
2. **Recursively mirror `$QUORUM_SCENARIO_DIR/fixtures/` into the workdir**
   (`cpSync(fixturesDir, workdir, { recursive: true })`).
3. `git add -A`, one commit (generic message, e.g. `seed scenario fixtures` —
   no check asserts the message).

The recursive mirror is deliberate: it makes the helper content-agnostic. For
the four SDD scenarios `fixtures/` is `{design.md, plan.md}`, which lands at the
workdir root and satisfies the existing `file-exists` checks. Because it copies a
**tree**, the same helper later absorbs any scenario whose starting state is an
arbitrary repo image (e.g. `fixtures/package.json` +
`fixtures/docs/superpowers/plans/report-plan.md`) at no extra cost.

This deletes the four `scaffoldSdd*` functions, their four registry entries, and
the `FIXTURES_DIR` constant.

### Layout

Per-scenario fixtures live in a `fixtures/` subdirectory of the scenario, not
loose in the scenario root:

```
scenarios/sdd-svelte-todo/
  story.md
  setup.sh           # setup-helpers run init_repo_from_fixtures
  checks.sh
  fixtures/
    design.md
    plan.md
```

The subdir keeps harness files (story/setup/checks) visually distinct from seed
content and is exactly the directory the generic helper mirrors. No ambiguity
about whether `plan.md` is scenario metadata or seed content.

### `quorum check` guard

Add a validation: a scenario whose `setup.sh` calls `init_repo_from_fixtures`
must have a non-empty `fixtures/` directory. Catches the "switched the verb,
forgot to move the files" mistake at validation time rather than mid-run.

## Migration

1. Add the env-var plumbing + `needsScenarioDir` + `init_repo_from_fixtures`,
   TDD: unit-test that given a temp scenario dir with a `fixtures/` tree, the
   helper mirrors it into the workdir and produces exactly one commit.
2. `git mv fixtures/sdd-*/ scenarios/sdd-*/fixtures/` (4 dirs) and change each
   `setup.sh` verb to `init_repo_from_fixtures`.
3. Delete the four `scaffoldSdd*` functions, their registry entries, and
   `FIXTURES_DIR`.
4. Add the `quorum check` guard.
5. Update docs: `docs/scenario-authoring.md` §3 ("`fixtures/` vs inline
   constants") and the helper-catalog table; the architecture note in
   `evals/CLAUDE.md`.
6. Verify: `bun run check` + `bun run quorum check`, then one live SDD run to
   confirm the seed + the `commits gte 4` post-check still hold.

## Out of scope

- **`template-repo` stays at `fixtures/template-repo/`.** It is shared, not
  per-scenario; forcing it into a single scenario directory would be wrong. The
  top-level `fixtures/` tree persists, holding only the shared template. Its two
  tests (`test/setup-helpers-base.test.ts:10`,
  `test/setup-helpers-worktree.test.ts:29`) reference only `template-repo` and
  are untouched.
- **Inline `*_PLAN_BODY` constants stay inline.** Converting the
  auth/broken/quality/yagni/spec-constraint helpers to file fixtures is a
  separate, behavior-touching change to live evals (each needs re-validation),
  and conflicts with one-problem-per-PR / smallest-reasonable-change. This design
  makes that migration **free later**: the generic helper already accepts an
  arbitrary fixture tree, so it reduces to `git mv`-ing the constant content into
  files. As a bonus, real `.md` files eliminate the literal-`\n` / `${}` escaping
  hazards those template-literal constants carry. New file-based fixtures should
  use `init_repo_from_fixtures`; the inline ones migrate opportunistically.

## Tradeoffs

- **Duplicated `design.md` across the two go-fractals scenarios** (byte-identical,
  1973 bytes). Accepted on purpose: a shared-fixture escape hatch would
  re-introduce exactly the cross-scenario coupling this design removes.
  Self-containment wins over deduplicating 2 KB.

## Cost

~3 files of plumbing, one new ~25-LOC helper minus four deleted ones (net
negative TS), 4 `git mv`s, one new validation guard, one doc edit.
