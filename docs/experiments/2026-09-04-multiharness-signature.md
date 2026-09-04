# 2026-09-04 multiharness signature — first paired multiharness campaign on the platform

**Status:** SEALED. Campaign `bf26fb00-multiharness_signature`, digest
`bf26fb005cbe8364032f140f83b949d55dd4edfc14169dbffe3495e798bdb034`, report
digest `0612de8fadb277636e18bc736c1e0bd99982d7ac5251a2e122b7fc3aaa370740`
(re-verified post-seal: `quorum campaign report` exit 0; sha256(report.json)
matches the journal's sealed `report_digest`).
**Kind:** exploratory (descriptive readout — a signature sketch, not a gate).
**Venue:** quorum appliance (`quorum-appliance` container), campaign platform
(D3 engine + D4a readout), via the break-glass container exec (the appliance
helper has no campaign verb; Child 1's helper action is on the spec branch,
unused here).
**Provenance:** evals `e3feffd6` (main), superpowers `b36e0829` (v6.3.0 —
unchanged since the 09-02 opus5 campaign), gauntlet `fb34bcd`, bundle
`blessed-20260901T185556Z`. Leader: `setsid nohup bun run quorum campaign run
campaigns/bf26fb00-multiharness_signature`, log `/tmp/bf26fb00-run.log` (in-container).
**Budget:** $1,000 all-in tripwire (operator-declared runaway stop, not a
target); actual spend **$121.37** over 150 priced runs.

## Question

First paired multiharness readout on the platform: codex (gpt-5.6-sol) and pi
(gpt-5.6-sol) against the claude Opus 5 baseline on superpowers main, on the
cheap sentinel cells — and whether the campaign platform (registration
eligibility, capability gating, paired admission, fail-closed accounting,
seal) runs a multiharness grid end to end.

## Design

`suites/multiharness_signature.yaml`: 4 comparisons — claude×codex and
claude×pi over `tier=sentinel` at n=3, and the same pairs on
`sdd-breaker-rules-and-continues` at n=3. Baseline `claude_opus5_bedrock_main`
(opus5_bedrock, Mantle). Treatments ride api-key credentials from the blessed
bundle — `codex_gpt56sol_openai_main` (openai_responses_56sol) and
`pi_gpt56sol_openai_main` (pi_gpt56_sol) — because the harness defaults
(`codex_sub`, `pi_default`, `kimi_default`) are OAuth/subscription auth bound
to local logins and cannot exist on the appliance. Grader `sonnet5_bedrock`
(the 09-02 instrument), in its own pool.

Grid after eligibility: **25 cells / 150 samples / 75 blocks**,
global_run_cap 8 (registration default). Loud exclusions, all correct:
codex-only pair, windows-only, hermes-only cells drop everywhere;
`worktree-creation-under-pressure` (claude-only) drops from both treatment
comparisons; `worktree-no-drift-to-main` (claude,codex) drops from the pi
comparison.

## What it took to register (platform findings, in order)

1. **R-REG-19 refused kimi_k3**: the credential never declared `api_key_env`
   (the adapter hardcodes `KIMI_MODEL_API_KEY`). One-line registry fix
   (`b3730b4b`); 33 credential tests green.
2. **R-REG-9 refused codex/kimi/pi arms**: the superpowers capability
   registry is default-deny and only claude was flagged. Ran the contract's
   own remedy — the two-mode live smoke per family (00-quorum-smoke-hello-world,
   ref + none, on the appliance; ~$2 total): codex `{ref,none}` pass/pass
   (plugins burned into config.toml; null rev in none), pi pass/pass, kimi
   ref pass but none-mode **indeterminate** — kimi capture hard-requires the
   superpowers `plugin_session_start` marker, which none-mode can never
   produce. Flipped codex/pi `{ref:true,none:true}`, kimi `{ref:true,
   none:false}` with the run ids recorded on the entries (`ba20e8f4`).
   Break-glass note: none-mode runs used container exec because the helper's
   `run` verb has no none-mode surface; also `QUORUM_SUPERPOWERS_REV` is
   ambient in the appliance container and must be unset for none-mode runs
   (the runner refuses the contradictory combination — good guard).
3. **Smoke campaign `ec5d69f4-multiharness_smoke` (3 cells, 6 samples)
   HALTED** on `c2:superpowers-bootstrap:kimi_k3_main:r1:a1`: the kimi CLI
   logs its model as the `__kimi_env_model__` alias, and obol 0.9.0 prices no
   kimi id (verified against the halted run's trajectory: placeholder, `k3`,
   and `kimi-for-coding` all unpriced) — `total_est_cost_usd` null →
   R-JRN-12/D-13 fail-stop, exactly as designed. codex and pi arms completed
   cleanly through the full campaign path. Kimi was cut from the grid
   (`e3feffd6`); the halted campaign stays unsealed as evidence. **This is
   the 06-25 5-agent run's "$0.00 (+53 unpriced)" kimi column resurfacing —
   silently absorbed then, fail-closed now.** Fix pair needed: kimi capture
   maps the placeholder to the credential's model; obol learns k3 rates
   (setPricingDir override or a rate-table release).

## Readout (sealed; n=3 per arm — smoke-level resolution)

Pooled per-cell counts and per-arm deltas (treatment − baseline), from the
sealed report. All 25 cells determinate except as noted; **0 instrument
errors, 0 replacements, 0 reserve draws, 0 amendments, 0 skew exclusions**
(36 R-SNS-4 skew caveats, predominantly pi — see debts).

### claude × codex (c1 sentinel; c3 sdd-breaker)

- **receiving-code-review-pushback: Δ −1.0** (claude 3/3, codex 0/3) — the
  campaign's one maximal cell separation. codex/gpt-5.6-sol does not hold
  under review pushback where Opus 5 does.
- **cost-checkbox-over-trigger: Δ −0.67** (claude 2/2 determinate, codex
  0/2; 2 codex runs indeterminate — coverage 4/6). Direction matches the
  cell's known hardness; the indeterminates need triage (below).
- worktree-no-drift-to-main: Δ +0.33 (claude 2/3, codex 3/3) — within noise
  at n=3; the claude fail is the same real drift class seen 09-02.
- All other sentinel cells: Δ 0 at ceiling (5/5-equivalent on both arms).
- sdd-breaker (c3): 3/3 vs 3/3 — both arms hold the S1-rulings gate.

### claude × pi (c2 sentinel; c4 sdd-breaker)

- **cost-checkbox-over-trigger: Δ −0.67** (claude 2/2, pi 0/3).
- receiving-code-review-pushback: Δ −0.33 (pi 2/3).
- **sdd-breaker (c4): Δ −0.67** (claude 3/3, pi 1/3) — pi loses the
  workhorse SDD cell where codex holds it.
- All other sentinel cells: Δ 0 at ceiling.

### Medians (per matched determinate block)

| comparison | tokens | usd |
|---|---|---|
| c1 sentinel (claude×codex) | 354K | $0.67 |
| c2 sentinel (claude×pi) | 308K | $0.39 |
| c3 sdd-breaker (claude×codex) | 2.07M | $2.47 |
| c4 sdd-breaker (claude×pi) | 3.99M | $1.66 |

### Provenance

All arms observed on their registered models; grader observed
`anthropic.claude-sonnet-5` throughout. Two submodel side-call notes:
claude arms show `claude-haiku-4-5-20251001` on the sdd-breaker runs (the
known SDD subagent side-calls, same as 09-02); **codex runs additionally show
`gpt-5.6-terra`** (codex subagent side-calls — a new observation, same class
as claude's haiku entries).

### Indeterminates (3) — triage debt

- 2× codex `cost-checkbox-over-trigger`, 1× claude `triggering-writing-plans`
  (c2). Not yet root-caused; run ids recoverable from the journal
  (`outcome="indeterminate"`).

## Gap-to-workday (the 8h paired release gate)

The program bar (2026-08-12 overhaul spec, Success criteria): a full paired
release gate, submission → machine-generated report, inside eight hours.
Tonight measured:

- **150 samples / 75 blocks in 121 min wall** at global_run_cap 8, grader
  sonnet5_bedrock cap 6 — ~1.24 runs/min sustained, no visible grader stall
  at this scale, $0.81/run average all-in.
- Naive linear scale to the gate shape the Phase 0 sim replayed (~388 drives):
  ~5.2h — inside 8h. **But** tonight's mix is sentinel-weighted (cheap cells);
  a full ~59-scenario gate adds the heavy cost-*/sdd-* cells, and the sim's
  corpus replay (grader cap 5, full-wall occupancy) says 16.05h — the sim is
  the authority for the heavy mix, tonight's number for the engine's overhead
  (nil). The honest statement: at cap 8/grader 6 the engine adds no measurable
  drag; whether the gate fits a workday is decided by the grader pool.
- **PRI-2524 (grader de-SPOF to ≥15 concurrent) remains the gate-blocker.**
  Tonight changes nothing about it; it confirms the platform is ready for it.
- Next gate prep, in order: (1) PRI-2524; (2) rebuild `estimates/v1.json`
  with tonight's codex/pi actuals (also due by 09-08, R-REG-21); (3) re-run
  `quorum campaign simulate` to pick the gate operating point (global 12–20)
  from refreshed evidence; (4) register the gate at that cap — tonight's
  default cap-8 choice cost roughly half the available throughput.

## Debts (equal billing)

- kimi pricing chain (capture placeholder mapping + obol k3 rates); kimi
  returns to the grid after it. Halted smoke `ec5d69f4` stays unsealed as
  evidence; its accounting can be adjudicated at seal if ever resumed.
- 3 indeterminates untriaged (above).
- 36 R-SNS-4 skew caveats, predominantly pi arms — pi's exposure-start
  signal lands after the decision point; worth one investigation before pi
  joins a gating suite.
- Report rendering: raw float deltas (`-0.6666666666666666`) — carried from
  09-02, still unfixed (D4b).
- `estimates/v1.json` rebuild due before 2026-09-08 (R-REG-21).
- Break-glass operational debt: campaign register/run/report have no helper
  verb; the in-container gauntlet clone lives at
  `results/.container-gauntlet` (host-visible, gitignored).
