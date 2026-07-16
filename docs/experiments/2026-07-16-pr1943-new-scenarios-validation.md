# 2026-07-16 — PR #1943 new scenarios: live validation (treatment vs control)

## Question

Do the two new quorum scenarios built to test obra/superpowers#1943's
plan-scoped-workspace behavior — `sdd-stale-foreign-workspace` (reject a
foreign flat ledger) and `sdd-same-plan-resume` (resume from your own scoped
ledger, don't redo task 1) — actually discriminate the PR's behavior from
what ships before it?

This is the companion to `2026-07-15-pr1943-sdd-regression-panel.md`. That
panel asked "does #1943 regress existing SDD behavior" (answer: no). This
run asks "do the *new* scenarios detect the behavior #1943 *adds*." The
scenarios themselves were designed, adversarially reviewed, and merged to
evals main in this session (spec + plan under `docs/superpowers/{specs,plans}/
2026-07-15-pr1943-sdd-workspace-scenarios*`).

## Config

- **Scenarios (2, both `status: draft` — run with `--include-drafts`):**
  `sdd-stale-foreign-workspace`, `sdd-same-plan-resume`.
- **Agents/credentials:** claude/`opus_bedrock`, codex/`openai_responses`
  (the credential-mismatched cells — claude·openai_responses,
  codex·opus_bedrock — are skipped by the scheduler, expected).
- **Arms:** treatment = PR head `5fa1ebc12270`; control = dev tip
  `fb7b07088ed0`. Paired same-day per the nonstationarity doctrine.
- **Where:** shared appliance via `evals-appliance` (Tailscale), evals ref
  `eaa41ae` (the merge that added these scenarios). Jobs:
  treatment `job-20260716T084240Z-1760` (batch `batch-20260716T084254Z-acc1`);
  control `job-20260716T090720Z-5ae6` (batch `batch-20260716T090733Z-2517`);
  stale-foreign control re-run after grader refuel
  `job-20260716T093906Z-ddc2` (batch `batch-20260716T093919Z-a667`).

## Matrix (n=1 per cell)

| Scenario | Treatment claude | Treatment codex | Control claude | Control codex |
|---|---|---|---|---|
| sdd-stale-foreign-workspace | ✓ pass | ✓ pass | ✗ fail | ✓ pass |
| sdd-same-plan-resume | ✓ pass | ✓ pass | ✗ fail | ✗ fail |

Approx coding-agent cost/cell: claude ~$1.5–2.3, codex ~$5–9 (obol; gauntlet
grader billed separately on Anthropic).

## Findings

**Both scenarios pass on the treatment (PR head), both agents.** The
plan-scoped-workspace skill does what the scenarios expect: it leaves the
foreign flat ledger byte-untouched and resumes its own scoped ledger without
re-dispatching task 1. This is live, independent evidence for #1943 —
distinct from the PR's own hand-scored evidence.

**`sdd-same-plan-resume` is the clean discriminator: PR ✓✓ / control ✗✗.**
Pre-#1943 the skill reads only the flat `.superpowers/sdd/progress.md`, never
finds the scoped ledger the fixture planted, and redoes task 1 → the
byte-identity anchor on `src/export-csv.js` fails on both agents. Exactly the
designed signal.

**`sdd-stale-foreign-workspace` control is a legitimate split: claude ✗ /
codex ✓ — and this vindicates the "fail-LEANING, not fail-by-construction"
framing the adversarial review forced into the spec.** Per-check detail on
the control cells:
- **claude control ✗** — every check passed *except* the post() stale-ledger
  byte-identity (`git hash-object .superpowers/sdd/progress.md` != the frozen
  literal). Both modules were delivered, `npm test` green, skill+Agent
  invoked, Gauntlet graded `pass`. The old skill **appended its progress to
  the flat ledger**, mutating it — precisely the mechanics regression the
  scenario exists to catch.
- **codex control ✓** — codex left the flat ledger untouched (hash matched),
  so it legitimately passed.

Had the spec kept its original "fails on control by construction" claim, this
codex pass would read as an anomaly. It isn't — a pre-#1943 agent that
happens not to touch the flat ledger *should* pass; the scenario only fails a
control agent that actually mutates it. The claude✗/codex✓ split is the
framing landing exactly as written.

## Incident: Gauntlet grader ran the shared Anthropic key dry mid-panel

The first control arm (`job-...090720Z`) returned `sdd-stale-foreign-workspace`
as **indeterminate on both agents** — `final_reason: "Gauntlet-Agent did not
complete (status: investigate)"`, `error.stage: None`. Root cause was NOT a
coding-agent or scenario problem: the shared **Anthropic** key behind the
Gauntlet-Agent (grader, pinned `claude-sonnet-5`) hit
`400 ... "Your credit balance is too low to access the Anthropic API"`
mid-run, right as the coding-agent reached the integration-choice prompt.
Confirmed by grepping the gauntlet `run.jsonl` for `credit balance is too low`
(1 hit in each indeterminate cell, 0 in the pass/fail cells). This is the
exact masked-billing failure mode in memory
[[appliance-gauntlet-billing-masks-capture]].

The budget lasted ~6 gauntlet runs (treatment's 4 + control's first 2) before
tipping over on the SDD-heavy stale-foreign scenario. Key was refueled (Drew,
ops), and the void cell re-ran clean (0 billing errors) to produce the control
row above. **Operational note:** the grader is still on direct Anthropic, not
Bedrock (open item PRI-2524) — so grader spend is a separate, exhaustible
budget from the `opus_bedrock` coding-agent credential, and an SDD panel burns
it fast.

## Verdict

Both new scenarios are sound and discriminate #1943's behavior as designed.
The behavior the scenarios test is present in the PR and absent before it.
They are valid regression guards once #1943 merges (flip `status: draft` →
`ready` at that point; until then they read fail/fail-leaning on any
pre-merge main by construction and must stay draft).
