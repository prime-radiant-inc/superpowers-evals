# 2026-09-02 Opus 5 signature — first real campaign on the platform

**Status:** RUNNING (launched 2026-09-02 00:48:04Z; results section pending)
**Kind:** exploratory (descriptive readout — a signature sketch, not a gate)
**Venue:** quorum appliance, campaign platform (D3 engine + D4a readout), via
the break-glass container exec; campaign dir
`campaigns/85089661-opus5_signature`, digest
`8508966105889827edf7a3defa21c9d01d1b82cbdfc969683a6e65e4b8517363`
**Budget:** $200 all-in (surcharge $16.55, priced coverage 1.0)

## Question

What does claude on **Opus 5** look like against **Opus 4.8** on the current
superpowers release, on the cheap behavioral cells where sample size buys
resolution — and does the campaign platform produce a usable readout end to
end on a real grid (14 cells, 136 runs) rather than the 1-cell exit smokes?

Drew's framing: "current opus5 vs opus48, readout, fractals and some
smokes." Fractals were dropped (below); the "smokes" became the
claude-eligible sentinel tier.

## Design

`suites/opus5_signature.yaml` (evals `a618712`, registered at `297ecfb`):

| comparison | baseline | treatment | scenarios | n |
|---|---|---|---|---|
| c1 | `claude_opus_bedrock_main` (Opus 4.8) | `claude_opus5_bedrock_main` (Opus 5) | `tier=sentinel` → 13 claude-eligible cells | 5 |
| c2 | same | same | `sdd-breaker-rules-and-continues` | 3 |

Both arms: agent `claude`, superpowers `main` = `b36e0829` (**v6.3.0** — the
08-09 gate's "dev" arm is now main), Bedrock Mantle route (`opus_bedrock` /
`opus5_bedrock`, us-east-1, bearer). Grader: **`sonnet5_bedrock`**
(`anthropic.claude-sonnet-5`, new credential `e0e825f`) — every corpus run
was graded by `claude-sonnet-5` on the plain route, so this keeps the grading
instrument comparable while riding the funded bearer; it sits in its own
pool (cap 6 under a 3M in / 300K out TPM Mantle quota). This is the first
campaign to exercise a sonnet grader through `mantleGraderEnv`; its first
`run_completed` is the live check.

Grid after registration: **14 cells, 136 samples, 68 blocks**, `global_run_cap
8` (4 two-arm blocks contemporaneous). Excluded, loudly:
`codex-tool-mapping-comprehension` (codex-only), `superpowers-bootstrap-
persistence` (hermes-only), `codex-windows-session-start-hook` (codex-only,
`# os: windows`).

### Deliberately out

- **`sdd-go-fractals-opus48`** — the corpus already holds n=10 per model:
  Opus 4.8 22.5 min / $7.37, Opus 5 75.5 min / $21.96 (p75 86 min, one
  116-min run against the 120-min cap). Re-buying that at ~$150 for the pair
  would not change the answer; the wall-time ratio (3.4×) is the finding.
- **`sdd-escalates-broken-plan`** — Opus 5 propensity settled: 0/10 on both
  arms in the 08-06 gate.

## Pre-registered expectations (written before any result landed)

- **H1 (instrument):** the sonnet5 grader on Mantle grades and prices; the
  report's Provenance shows `observed [claude-sonnet-5]` for the grader and
  the native ids for both arms; `failed_cells` empty. If this fails the whole
  campaign is instrument-invalid, not a model finding.
- **H2 (sdd-breaker, c2):** both arms pass at similar rates — v6.3.0 carries
  the S1 rulings change that moved this cell 0/10 → 8/10 (Opus 4.8) and
  0/6 → 7/7 (Opus 5) on 08-09. A main-arm collapse here would be a
  regression signal about main, not about Opus 5.
- **H3 (cost-checkbox-over-trigger):** Opus 4.8 stays at its floor (0/46
  across 9 refs); the only informative outcome is Opus 5 passing — the cell
  is one-directional.
- **H4 (sentinel bulk):** the 08-09 sentinel rider was 10/10 on Opus 4.8 for
  its 5-scenario subset; the full 13-cell tier on 4.8 should sit high with
  known soft spots (brainstorming over-trigger, writing-plans gate skip —
  both seen on Sonnet 5, direction on Opus 5 unknown). Δ(Opus 5 − Opus 4.8)
  per cell is the readout; with n=5 only large deltas (≥3/5) mean anything.
- **H5 (economics):** Opus 5 runs cost ~1.5× and take ~1.6× the wall time of
  Opus 4.8 on the workhorse SDD cell (corpus: $2.15 / 9.5 min vs $3.22 / 15
  min); sentinel cells stay under ~$1.50 each on both.
- **Negative results are recorded at equal billing.** A null delta across
  the tier is the expected, and useful, outcome.

## What the campaign found on the way in

**Registration ignored scenario eligibility directives.** The first dry run
expanded `tier=sentinel` to **16** cells (166 samples): the campaign intake
hard-coded `os: undefined` and never read `# coding-agents:`, so the
codex-only, hermes-only, and windows-only scenarios were admitted onto
claude arms — 30 samples that would have burned to indeterminate and
polluted the readout — and the R-REG-14 scenario-os leg was dead code. The
platform spec (PAR §Suites) already pinned the rule ("a scenario dropped by
a `# coding-agents:` directive is dropped within its comparison for both
arms, loudly, in `excluded_cells`"); D3's implementation missed it. Fixed in
evals `297ecfb` (both intake readers share one scenario-intake builder
reading text-based twins of the run-all directive parsers; tests at the
pure core, the reason table, and a published registration with both
directives). Dry run after the fix: 14 cells, the three exclusions named.
Campaigns still do not honor story `status: draft` (run-all does) — moot
here, all sentinel scenarios are `ready`; noted as debt.

**Provenance native-id fix confirmed live** first (the D4a follow-on
`2132a26`): 1-cell bedrock exploratory `a13443c9-d4a_live_exploratory`
sealed with `observed [claude-opus-4-8]` against registered
`anthropic.claude-opus-4-8`, `failed_cells: (none)`, medians populated
(57,132 tokens / $0.58). Cosmetic: the Provenance section lists every arm in
`arms/`, not just the suite's (unused arms render `observed []`).

## Appliance provenance

`evals-appliance prepare` job `job-20260902T004626Z-bc1a`: evals `297ecfb`,
gauntlet `fb34bcd` (`/tmp/gauntlet-live` clone at the same SHA), superpowers
`b36e0829`, credential bundle `blessed-20260901T185556Z`, container
`fc4dd3aab09b…`. Leader: `setsid nohup bun run quorum campaign run
campaigns/85089661-opus5_signature`, log `/tmp/85089661-run.log`.

## Results

_Pending — filled from `quorum campaign report` (rates, medians, delta,
provenance) and per-run `quorum show`/`costs` after the seal._
