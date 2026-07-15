# PR-1943 SDD plan-scoped workspace scenarios — design

**Date:** 2026-07-15
**Status:** approved (Drew, in-session)
**Context:** obra/superpowers#1943 (`sdd-plan-scoped-workspace`, head
`5fa1ebc1`) rewrites the SDD durable-progress mechanism: per-plan artifact
directories (`.superpowers/sdd/<plan-basename>/`), a self-identifying ledger
(first line names the plan file), and end-of-plan workspace cleanup. No
quorum scenario probes this behavior surface. The regression panel
(job-20260715T191039Z-5835 + paired control) covers "did the rewrite break
existing SDD behavior"; these two new scenarios cover the behavior the PR
*adds*.

## Goals

- Pin the discrimination the PR builds: **reject foreign progress, trust
  your own.** One scenario per direction; an always-redo agent passes the
  first and fails the second, a blind-adopter passes the second and fails
  the first.
- Mirror the PR's own S1-GREEN / S2-GREEN eval design so quorum results
  read directly against its committed evidence
  (`docs/superpowers/specs/2026-07-06-sdd-plan-scoped-workspace-eval-results.md`
  on the PR branch).
- Hybrid check philosophy (decided in-session): behavior-neutral core ACs
  plus separately-grouped mechanics assertions pinned to the new layout, so
  a future layout change flips only the mechanics checks.

## Decisions (from brainstorming)

| Decision | Choice |
| --- | --- |
| Check strictness | Hybrid: neutral core + pinned mechanics |
| Tier / life | `quorum_tier: full`, permanent |
| Agent scope | All agents (no `# coding-agents:` restriction) |
| Set shape | Two scenarios (Option B); dedicated cleanup scenario rejected as YAGNI — cleanup is a post-check both scenarios carry |

## Scenario 1: `sdd-stale-foreign-workspace`

Refusing foreign progress — the obra/superpowers#1936 failure shape.

**Fixture** (new Tier-1 helper `scaffold_sdd_stale_foreign_workspace` in
`src/setup-helpers/sdd-fixtures.ts`):

- Small npm repo on `main`; a finished earlier feature (`notes` module)
  with real git history.
- **Untracked** stale ledger at the legacy flat path
  `.superpowers/sdd/progress.md`: old format, no identity line, reads
  `Task 1: complete… Task 2: complete…` describing the *old* plan.
- New 2-task plan at `docs/superpowers/plans/2026-07-15-report-export.md`;
  task numbering deliberately overlaps (1–2), separate target files per
  task, `npm test` green only when both new modules exist.

**Story:** human asks the agent to execute the new plan with SDD,
autonomously. If the agent asks whether the existing `.superpowers/sdd`
state is its own, the Gauntlet-Agent answers: "no idea what that is — I
just want the export plan done." Failure mode under test: agent adopts the
stale ledger, believes tasks 1–2 done, completes without delivering.

**Checks:**

- Neutral core (`post`): both new-plan modules exist with required
  exports; `npm test` passes; `check-transcript skill-called
  superpowers:subagent-driven-development`; `check-transcript tool-called
  Agent`.
- Mechanics (`post`): the flat stale ledger still exists and is
  byte-identical to the fixture copy — the ledger body is a fixed
  constant in the helper, so `checks.sh` compares against a hardcoded
  SHA-256 literal via `command-succeeds` (no recorded-state seam
  needed); `not file-exists
  '.superpowers/sdd/2026-07-15-report-export/'` (own workspace cleaned up
  after clean final review).
- Discrimination note: pre-PR main appends its own progress to the flat
  ledger, so byte-identity discriminates the arms even when the neutral
  core passes (the PR's RED baseline showed current controllers usually
  refuse adoption — mechanics checks are what will move).

## Scenario 2: `sdd-same-plan-resume`

Trusting your own truthful ledger.

**Fixture** (new Tier-1 helper `scaffold_sdd_same_plan_resume`): simulates
a controller that died mid-plan.

- Same small-repo skeleton and the same 2-task plan; task 1 =
  `src/export-csv.js`, task 2 = `src/export-json.js`; `npm test` green
  only when both exist.
- Task 1's work is real: helper commits `src/export-csv.js` + its test on
  `main` ("Task 1: CSV export (SDD)").
- Truthful ledger at the **scoped** path
  `.superpowers/sdd/2026-07-15-report-export/progress.md`, first line
  `# SDD ledger — plan: docs/superpowers/plans/2026-07-15-report-export.md`,
  then `Task 1: complete (commits <base7>..<head7>, review clean)` with
  the fixture's **real** commit hashes interpolated at commit time (the
  PR's first fixture iteration was discarded for fabricated hashes; do
  not repeat that).
- `.superpowers/sdd/.gitignore` containing `*`, exactly as
  `sdd-workspace` writes it.

**Story:** framed as a resume — an earlier session started this plan and
was interrupted; pick it up with SDD and finish. If the agent asks whether
the ledger is trustworthy: "whatever the workspace says — you left it
there."

**Checks:**

- Neutral core (`post`): both modules exist; `npm test` passes; skill +
  Agent dispatch in transcript.
- Resume discrimination (`post`): `src/export-csv.js` byte-identical to
  the fixture commit — `post()` recovers the task-1 commit from git
  history itself (the commit that *added* the file:
  `git log --diff-filter=A --format=%H -- src/export-csv.js`) and
  `command-succeeds 'git diff --quiet <that-sha> HEAD --
  src/export-csv.js'`; no recorded-state file needed. The
  "no task-1 re-implementation, resumed at task 2" judgment is semantic
  and lives in the ACs for the Gauntlet-Agent, with the byte-identity
  check as the deterministic anchor (belt-and-braces).
- Mechanics (`post`): workspace directory deleted at completion
  (`not file-exists`).

**By-construction asymmetry (must stay documented in the story):** pre-PR
main looks for the flat `progress.md`, finds nothing, and redoes task 1 —
this scenario reads **fail on control** by design. It is a treatment
discriminator until #1943 merges, then a pure regression guard. The story
frontmatter carries a comment noting this so a control-arm fail is never
mis-triaged.

## Shared scenario metadata

- `status: ready`, `quorum_tier: full`,
  `tags: subagent-driven-development`, `quorum_max_time: 60m`.
- No agent restriction; fixtures stay small (2-task plans, no heavy
  builds) to keep all-agent full-tier cost in the same class as
  `sdd-spec-constraint-preserved` and bounded for kimi.

## Testing

- Both helpers are Tier-1 (git + fs only): unit tests beside the existing
  `sdd-fixtures` tests assert the identity line, the real-SHA
  interpolation (resume fixture), the stale ledger's old format (foreign
  fixture), and the `.gitignore` content.
- `bun run quorum check` passes on both scenarios.
- TDD per house rules: helper tests written first.

## Out of scope

- A dedicated cleanup scenario (YAGNI — carried as a post-check in both).
- Changes to existing sdd-* scenarios.
- The regression panel itself (running separately; results land in
  `docs/experiments/2026-07-15-pr1943-sdd-regression-panel.md`).
