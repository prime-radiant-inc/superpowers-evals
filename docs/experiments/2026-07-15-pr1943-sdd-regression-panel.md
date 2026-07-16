# 2026-07-15 — PR #1943 SDD regression panel (plan-scoped workspace)

## Question

Does obra/superpowers#1943 (`sdd-plan-scoped-workspace`, head `5fa1ebc1`) —
which rewrites `subagent-driven-development/SKILL.md`, its three scripts
(`sdd-workspace`, `task-brief`, `review-package`), `task-reviewer-prompt.md`,
and the codex session-start hook — regress any existing SDD-family behavior?

This is a pure regression panel. No quorum scenario probes the new
plan-scoped-workspace behavior itself; the PR carries its own hand-scored
40-rep evidence for that (committed on its branch,
`docs/superpowers/specs/2026-07-06-sdd-plan-scoped-workspace-eval-results.md`).

## Config

- **Panel (9 scenarios):** sdd-escalates-broken-plan,
  sdd-quality-reviewer-catches-planted-defect, sdd-rejects-extra-features,
  sdd-spec-constraint-preserved, sdd-spec-context-consumed, sdd-svelte-todo,
  subagent-dispatch-no-overtrigger, user-pref-sdd-no-strategy-prompt,
  superpowers-bootstrap (hook canary). Model-pinned variants excluded.
- **Agents/credentials:** claude/`opus_bedrock`, codex/`openai_responses`.
- **Arms:** treatment = PR head `5fa1ebc12270`; control = dev tip
  `fb7b07088ed0` (Drew's call: operational "vs what ships today" comparison,
  not the merge base `c809093a`). Paired same-day runs per the
  nonstationarity doctrine; no historical baselines read as evidence.
  Caveat: dev tip includes 28 commits of drift since the PR branched
  (incl. the merged #1932–1935 SDD/TDD skill edits), so a divergent cell
  is PR-vs-drift ambiguous — none ended up mattering.
- **Where:** shared appliance via `evals-appliance` (Tailscale). Jobs:
  treatment `job-20260715T191039Z-5835` (claude) +
  `job-20260715T222832Z-ff86` (codex retry, see harness notes);
  control `job-20260715T233634Z-e82c` + single-cell re-run
  `job-20260716T062341Z-d4fc`. Rep chain for triage:
  `job-20260716T{071906Z-27c9,073132Z-62e7,074935Z-4b3d,080337Z-4e0f}`.
  Batches: `batch-20260715T191052Z-bb5d`, `batch-20260715T222847Z-7b9e`,
  `batch-20260715T233647Z-66fa`, `batch-20260716T063129Z-ce37`.

## Matrix (n=1 per cell unless noted)

| Scenario | claude PR→dev | codex PR→dev |
|---|---|---|
| sdd-escalates-broken-plan | pass→pass | pass→pass |
| sdd-quality-reviewer-catches-planted-defect | fail→pass (see reps) | fail→fail |
| sdd-rejects-extra-features | pass→pass | pass→pass |
| sdd-spec-constraint-preserved | pass→pass | pass→pass |
| sdd-spec-context-consumed | fail→investigate⊘ | fail→fail |
| sdd-svelte-todo | pass→pass | pass→pass |
| subagent-dispatch-no-overtrigger | pass→pass | fail→fail |
| superpowers-bootstrap | pass→pass | pass→pass |
| user-pref-sdd-no-strategy-prompt | fail→fail | pass→fail |

## Triage of divergent cells

- **sdd-quality-reviewer-catches-planted-defect (claude), the only candidate
  regression** — fail on PR / pass on dev at n=1, with a plausible mechanism
  (the PR touches `task-reviewer-prompt.md`). Repped per the 3-strike
  doctrine: **PR = F,P,P; dev = P,⊘(investigate),F.** Both arms wobble;
  the scenario is noisy at both refs (grader judgment call on whether the
  reviewer's examination of the planted duplication counts as a catch).
  **Not a regression.**
- **sdd-spec-context-consumed (claude)** — PR-arm fail is the controller
  never invoking SDD (loaded executing-plans, self-implemented). Same
  failure occurred twice on dev in June; the PR does not touch the skill's
  frontmatter/description, so there is no trigger-surface mechanism. The
  control-arm "investigate" had SDD correctly invoked and tests green
  (grader quibble: spec text pasted into reviewer but not implementer
  prompts). Known invocation flakiness, not a PR effect.
- **user-pref-sdd-no-strategy-prompt** — claude fails both arms on the same
  deterministic `tool-not-called AskUserQuestion` trip (a workspace/git
  question, not a strategy prompt; grader passed it both times). Scenario
  strictness question, pre-existing, filed under scenario debt. Codex
  flipped pass→fail in the PR's favor — noise.
- **subagent-dispatch-no-overtrigger (codex)** — fail both arms; matches
  codex's documented under-invocation signature.

## Verdict

**No regression attributable to PR #1943 on this panel.** Every divergence
either dissolved under reps, pre-exists on dev, or moved in the PR's favor.
The PR's hook/packaging changes are clean (superpowers-bootstrap pass on
both agents both arms; dev-side bootstrap also passing 25+ consecutive
appliance runs).

Negative results at equal billing:

- The panel's three claude "fails" on the PR head at n=1 would all have
  read as regressions without the paired control + reps. None survived.
- `sdd-quality-reviewer-catches-planted-defect` and
  `sdd-spec-context-consumed` are now demonstrated-noisy on claude at n=3
  and should not be read at n=1 in future panels.

## Harness notes (not PR-related)

- The appliance's codex default credential is `codex_sub` (ChatGPT
  subscription auth, not seeded) → all 9 codex cells indeterminate on the
  first treatment batch. Pass `--credentials openai_responses` explicitly
  for codex on the appliance. (Matches the appliance-credentials memory;
  bit us anyway because run-all fell back to the agent default.)
- Control batch wedged on its last cell (`sdd-svelte-todo`/claude): worker
  pid dead, orphaned scenario `vite` dev server kept the run alive ~5.5h;
  `phase.json` frozen at `checks`. Cancelled the job (lock released
  cleanly), re-ran the cell — pass. Suggests the runner should reap the
  workdir process tree when a phase stalls.
- `evals-appliance run-all` double-registered one submission (two job
  records 30s apart, identical argv; second failed `lock_busy` against the
  first). Net effect one running job, but the failure surfaced as a
  confusing `appliance_failed: true`.
