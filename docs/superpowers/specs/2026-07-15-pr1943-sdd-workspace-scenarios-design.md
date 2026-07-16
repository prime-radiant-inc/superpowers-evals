# PR-1943 SDD plan-scoped workspace scenarios — design

**Date:** 2026-07-15
**Status:** approved (Drew, in-session); amended same day after two-reviewer
adversarial review (14 verified findings consolidated — see Amendments)
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
  first scenario's *neutral core* and fails the second, a blind-adopter
  passes the second and fails the first. (On pre-PR control, even an
  always-redo agent fails the first scenario's *mechanics* checks — the
  old skill appends to the flat ledger. The neutral core and the
  mechanics group have different pass contours by design; never collapse
  them in triage.)
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
| Tier / life | `quorum_tier: full`, permanent (amended: `status: draft` until #1943 merges — see Amendments §6) |
| Agent scope | All agents (no `# coding-agents:` restriction) |
| Set shape | Two scenarios (Option B); dedicated cleanup scenario rejected as YAGNI — cleanup is a post-check both scenarios carry |

## Scenario 1: `sdd-stale-foreign-workspace`

Refusing foreign progress — the obra/superpowers#1936 failure shape.

**Fixture** (new Tier-1 helper `scaffold_sdd_stale_foreign_workspace` in
`src/setup-helpers/sdd-fixtures.ts`):

- Small npm repo on `main`; a finished earlier feature (`notes` module)
  with real git history.
- **Untracked** stale ledger at the legacy flat path
  `.superpowers/sdd/progress.md`: old format, no identity line, entries
  `Task N: complete (commits <base7>..<head7>, review clean)` describing
  the *old* plan — with **real** short hashes interpolated from the
  `notes`-module fixture commits (pre-PR's own append format includes
  commit ranges; a hashless ledger lets a control agent distrust it for
  the wrong reason — missing evidence rather than foreign identity).
- `.superpowers/sdd/.gitignore` containing `*`, exactly as the **pre-PR**
  `sdd-workspace` wrote it (verified at merge base `c809093a`, line 21):
  genuine stale state is invisible to `git status`. Without it the
  ledger shows up as untracked noise — an artificial cue that either
  tips agents off or provokes deletion, contaminating the byte-identity
  check.
- New 2-task plan at `docs/superpowers/plans/2026-07-15-report-export.md`;
  task numbering deliberately overlaps (1–2), separate target files per
  task. The fixture suite is **green at handoff** (it covers the `notes`
  module only); each plan task directs the agent to write its module's
  tests (house pattern, same as scenario 2). A fixture that shipped red
  tests for the unbuilt modules would tip off a ledger-adopting agent
  for fixture reasons rather than exercise the discrimination.

**Story:** human asks the agent to execute the new plan with SDD,
autonomously. If the agent asks whether the existing `.superpowers/sdd`
state is its own, the Gauntlet-Agent answers: "no idea what that is — I
just want the export plan done." Failure mode under test: agent adopts the
stale ledger, believes tasks 1–2 done, completes without delivering.

**Worktree pinning (required, both scenarios):** the fixtures'
load-bearing state is untracked and does **not** propagate into
`git worktree add` checkouts — an agent working in a worktree never sees
the planted ledger, voiding the stimulus (scenario 1 passes vacuously;
scenario 2 false-fails). Both stories therefore adopt the
`sdd-spec-constraint-preserved` pattern verbatim: the deliverable must
end up in the checkout the agent launched in; if the agent asks about
worktrees or branches, the Gauntlet-Agent answers "work in this checkout
on `main`"; the agent is not done until the work is present in the main
checkout. The endgame must also be driven explicitly (see cleanup checks
below): the Gauntlet-Agent lets the agent run its full SDD flow —
final whole-branch review included — and does not stop it at "tests
pass."

**Checks:**

- Neutral core (`post`): both new-plan modules exist with required
  exports; `npm test` passes; `check-transcript skill-called
  superpowers:subagent-driven-development`; `check-transcript tool-called
  Agent`.
- Mechanics (`post`): the flat stale ledger still exists and is
  byte-identical to the fixture copy. The ledger embeds fixture-commit
  hashes, so the helper makes those commits **deterministic** (fixed
  `GIT_AUTHOR_DATE`/`GIT_COMMITTER_DATE`, fixed author/committer
  identity) — same commits every run, same short hashes, same ledger
  bytes — and `checks.sh` compares against a hardcoded SHA-256 literal
  via `command-succeeds` (unit tests assert the hash is stable). Also:
  `not file-exists '.superpowers/sdd/2026-07-15-report-export/'` (own
  workspace cleaned up after clean final review — meaningful only
  because the story drives the full endgame and pins the main checkout).
- Discrimination note: pre-PR main appends its own progress to the flat
  ledger, so byte-identity discriminates the arms even when the neutral
  core passes (the PR's RED baseline showed current controllers usually
  refuse adoption — mechanics checks are what will move).
- **Mis-triage guard (this scenario too):** a control-arm mechanics fail
  here is expected behavior of the old skill, not a regression. The
  story frontmatter carries the same comment scenario 2 does.

## Scenario 2: `sdd-same-plan-resume`

Trusting your own truthful ledger.

**Fixture** (new Tier-1 helper `scaffold_sdd_same_plan_resume`): simulates
a controller that died mid-plan.

- Same small-repo skeleton and the same 2-task plan; task 1 =
  `src/export-csv.js`, task 2 = `src/export-json.js`. **`npm test` must
  be green at handoff** with only task 1 present: task 1's tests ship in
  the fixture; task 2's tests are written by the agent per its task
  (house pattern). A red suite under a ledger claiming "review clean" is
  the exact contradiction the PR's own eval discarded a fixture over — a
  careful controller would distrust the ledger for fixture reasons, not
  skill reasons.
- Task 1's work is real: helper commits `src/export-csv.js` + its test on
  `main` ("Task 1: CSV export (SDD)").
- The plan's task 2 carries an explicit constraint: "`export-json.js` is
  self-contained; do not modify `src/export-csv.js`." This makes the
  byte-identity anchor sound — without it, a legitimate final-review fix
  or shared-helper extraction touching task-1 code would force a
  deterministic fail on a correct resume.
- Truthful ledger at the **scoped** path
  `.superpowers/sdd/2026-07-15-report-export/progress.md`, first line
  `# SDD ledger — plan: docs/superpowers/plans/2026-07-15-report-export.md`,
  then `Task 1: complete (commits <base7>..<head7>, review clean)` with
  the fixture's **real** commit hashes interpolated at commit time (the
  PR's first fixture iteration was discarded for fabricated hashes; do
  not repeat that). Fixture commits are deterministic here too (fixed
  dates/identity, as in scenario 1), so the interpolated ledger is
  byte-stable across runs.
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
  the fixture version — compared against a **hardcoded SHA-256 of the
  fixture constant** (the file body is a fixed string in the helper), via
  `command-succeeds 'echo "<sha>  src/export-csv.js" | shasum -a 256 -c'`.
  Git archaeology (`git log --diff-filter=A`) was rejected: it returns
  newest-first with one hash per add, so a violator that deletes and
  re-adds the file makes the natural pick the violator's own commit — a
  false pass on precisely the redo arm this check must catch. The
  "no task-1 re-implementation, resumed at task 2" judgment is semantic
  and lives in the ACs for the Gauntlet-Agent, with the byte-identity
  check as the deterministic anchor (belt-and-braces).
- Mechanics (`post`): workspace directory deleted at completion
  (`not file-exists`).

**Control-arm asymmetry (must stay documented in the story):** pre-PR
main looks for the flat `progress.md` and finds nothing there — but the
old skill *also* says to trust `git log`, and the fixture's task-1 commit
message ("Task 1: CSV export (SDD)") is discoverable. A pre-PR controller
can therefore legitimately recover and pass. The expectation is
**fail-leaning on control, not fail-by-construction**: control passes are
legitimate, control fails are expected, and neither is a regression
signal. The scenario is a probabilistic treatment discriminator until
#1943 merges, then a pure regression guard. The story frontmatter carries
a comment noting this so a control-arm result is never mis-triaged.

## Shared scenario metadata

- `status: draft` until obra/superpowers#1943 merges, then flip to
  `status: ready`. Shipping ready/full-tier pre-merge would put a
  deterministic red column into every routine full-tier batch against
  superpowers main (aggregate views count the fails regardless of
  frontmatter comments). Pre-merge runs use `--include-drafts`
  explicitly.
- `quorum_tier: full`, `tags: subagent-driven-development`,
  `quorum_max_time: 90m` — matching `sdd-spec-constraint-preserved`,
  whose cost class these scenarios target; 60m was inconsistent with
  that claim and converts known-slow harnesses (kimi on SDD,
  antigravity) into timeout indeterminates.
- No agent restriction; fixtures stay small (2-task plans, no heavy
  builds) to keep all-agent full-tier cost in the same class as
  `sdd-spec-constraint-preserved` and bounded for kimi.

## Testing

- Both helpers are Tier-1 (git + fs only): unit tests beside the existing
  `sdd-fixtures` tests assert the identity line, the real-SHA
  interpolation (resume fixture), the stale ledger's old format + real
  commit ranges (foreign fixture), the `.gitignore` content in **both**
  fixtures, commit determinism (two runs produce identical commit hashes
  and identical ledger bytes; the hardcoded SHA-256 literals in
  `checks.sh` match), and that `npm test` is green at handoff in the
  resume fixture.
- `bun run quorum check` passes on both scenarios (with drafts included).
- TDD per house rules: helper tests written first.

## Amendments (2026-07-15, post-adversarial-review)

Two bounded adversarial reviewers (competition-scored; 14 verified
findings, 4 overlapping) drove these changes. None overturned the
two-scenario shape; all hardened fixtures, checks, or claims:

1. **Worktree pinning** (both reviewers, most severe): untracked fixture
   state doesn't propagate into worktrees; stories now pin delivery to
   the main checkout and drive the full endgame, per the
   `sdd-spec-constraint-preserved` pattern.
2. **Green tests at handoff** (S2): red suite under a "review clean"
   ledger reproduced the contradiction the PR's own eval discarded a
   fixture over; task-1 tests now ship green, task 2 brings its own.
3. **Content-SHA anchors, no git archaeology**: `git log
   --diff-filter=A` is newest-first/one-per-add → false pass on
   delete-and-re-add redos; both byte-identity checks now compare
   hardcoded SHA-256 literals of deterministic fixture content, and S2's
   plan forbids task 2 from touching `export-csv.js` so legitimate work
   can't trip the anchor.
4. **Discrimination claims corrected**: S1 Goals no longer claim
   always-redo passes on control (mechanics fail there by design); S2
   softened from "fail on control by construction" to fail-leaning
   (pre-PR `git log` recovery is a legitimate control pass); mis-triage
   comments now required on both stories.
5. **Fixture fidelity** (S1): `.superpowers/sdd/.gitignore` seeded (old
   `sdd-workspace` always wrote it — verified at `c809093a`) and stale
   ledger carries real commit ranges in the pre-PR append format.
6. **Lifecycle + budget**: `status: draft` until #1943 merges (no
   deterministic red columns in routine batches); `quorum_max_time: 90m`
   matching the cost-class sibling.

## Out of scope

- A dedicated cleanup scenario (YAGNI — carried as a post-check in both).
- Changes to existing sdd-* scenarios.
- The regression panel itself (running separately; results land in
  `docs/experiments/2026-07-15-pr1943-sdd-regression-panel.md`).
