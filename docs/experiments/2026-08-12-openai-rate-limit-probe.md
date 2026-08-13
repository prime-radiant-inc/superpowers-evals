# OpenAI rate-limit probe: headers + concurrency ramp

**Date:** 2026-08-12 (probe executed 2026-08-13T00:45–00:55Z)
**Context:** PRI-2874 W7 pre-spec evidence. The program spec's criterion-1
capacity math named the shared `api.openai.com/v1|openai-responses` pool
(harness cap 5) as the binding quota path; the cap's own comment records it
as a billing misdiagnosis, never a measured ceiling. Decision 10 (resources
unconstrained) makes the measured ceiling the only question.
**Method:** run from the appliance over the blessed bundle key. Stage 0: one
minimal `POST /v1/responses` per model, reading `x-ratelimit-*` enforcement
headers. Stage 1: `rate-probe.ts` concurrency ramp — N parallel sessions,
75s per level, each request ~3k input / ≤600 output tokens (unique filler,
uncached worst case), recording status, latency, usage, and remaining-quota
headers. Sol ramped 5/10/15/20; luna spot-checked at 10. No live evals ran
concurrently (doctor: no locks).

## Stage 0 — enforced org limits (ground truth from headers)

| Model | RPM limit | TPM limit |
|---|---|---|
| gpt-5.5 | 15,000 | 40,000,000 |
| gpt-5.6-sol | 15,000 | 40,000,000 |
| gpt-5.6-luna | 30,000 | 180,000,000 |

Three separate per-model buckets on the one org, exactly matching the
2026-08-12 research figures. The harness limiterKey merges all three into
one pool today, discarding ~3× of available capacity by construction.

## Stage 1 — concurrency ramp, gpt-5.6-sol

| Concurrency | Requests | 429s | Errors | p50 ms | p95 ms | Effective TPM | Bucket utilization |
|---|---|---|---|---|---|---|---|
| 5 | 110 | 0 | 0 | 3,318 | 5,549 | 185,142 | 0.5% |
| 10 | 204 | 0 | 0 | 3,532 | 5,955 | 332,030 | 0.8% |
| 15 | 342 | 0 | 0 | 3,162 | 4,918 | 566,864 | 1.4% |
| 20 | 442 | 0 | 0 | 3,215 | 5,195 | 732,848 | 1.8% |

Luna at 10-way: 360 requests, 0×429, p50 1,944ms, 616,379 effective TPM
(0.3% of its bucket). `min_remaining_requests` never dropped below 14,998
(sol) / 29,998 (luna).

## Findings

1. **No concurrency-level throttling exists at ≥20 parallel sessions.**
   Latency is flat from 5-way to 20-way and throughput scales linearly
   (3.96× tokens at 4× workers). OpenAI enforces RPM/TPM windows only;
   there is no separate session-concurrency limiter at this scale. The
   historical cap 5 was purely a harness artifact.
2. **The enforced buckets match the spec's numbers exactly** (40M/15k sol,
   180M/30k luna, per-model). The spec's usage-Tier-5 claims are now
   ground-truth, not aggregator-sourced.
3. **Real-workload utilization estimate:** a codex agent session presents
   ~100–250k cache-inclusive input per turn every ~10–30s. At 15 concurrent
   sessions that is ~7–23M TPM against the 40M sol bucket (17–56%). Fits
   without purchase; if the Stage-2 real-run probe on the resized host
   sustains >60%, buy the committed-capacity product (Reserved Tier for
   5.6-class) per the program spec.

## Implications for PRI-2874

- W7's OpenAI item collapses to configuration: raise the shared pool's
  `max_concurrency` toward 15–20 (all limiterKey members together), then
  split per-model `quota_pool_id`s when the registry lands. No purchase
  needed at current battery scale.
- The formal "controlled saturation receipt" (W7 exit) still requires the
  Stage-2 real-run probe under pinned resources on the resized host — this
  probe is synthetic and deliberately did not exhaust TPM.

## Limitations

Synthetic 3k-token requests are not agent traffic (real sessions carry
30–80× larger cache-inclusive prompts); 75s windows sample one time of day;
TPM exhaustion was not attempted (would cost ~$80+ for no additional
decision value). Probe spend: ~3.22M tokens ≈ single-digit dollars;
reconcile exact cost on the billing page.

**Artifacts:** probe script `rate-probe.ts` (session scratchpad; inline in
this entry's commit), raw JSON on the appliance at `/tmp/probe-sol.json`,
`/tmp/probe-luna.json` (copies below).

<details><summary>Raw sol JSON</summary>

```json
{"model":"gpt-5.6-sol","at":"2026-08-13T00:52:40.590Z","level_seconds":75,
"levels":[
{"level":5,"elapsed_s":78.7,"requests":110,"ok":110,"r429":0,"other_err":0,"p50_ms":3318,"p95_ms":5549,"total_tokens":242727,"eff_tpm":185142,"min_remaining_tokens":39999960,"min_remaining_requests":14998},
{"level":10,"elapsed_s":81.8,"requests":204,"ok":204,"r429":0,"other_err":0,"p50_ms":3532,"p95_ms":5955,"total_tokens":452762,"eff_tpm":332030,"min_remaining_tokens":39999974,"min_remaining_requests":14999},
{"level":15,"elapsed_s":79.9,"requests":342,"ok":342,"r429":0,"other_err":0,"p50_ms":3162,"p95_ms":4918,"total_tokens":754506,"eff_tpm":566864,"min_remaining_tokens":39999985,"min_remaining_requests":14998},
{"level":20,"elapsed_s":79.8,"requests":442,"ok":442,"r429":0,"other_err":0,"p50_ms":3215,"p95_ms":5195,"total_tokens":975128,"eff_tpm":732848,"min_remaining_tokens":39999984,"min_remaining_requests":14998}]}
```
</details>

<details><summary>Raw luna JSON</summary>

```json
{"model":"gpt-5.6-luna","at":"2026-08-13T00:53:58.186Z","level_seconds":75,
"levels":[
{"level":10,"elapsed_s":77.6,"requests":360,"ok":360,"r429":0,"other_err":0,"p50_ms":1944,"p95_ms":3469,"total_tokens":796947,"eff_tpm":616379,"min_remaining_tokens":179999973,"min_remaining_requests":29998}]}
```
</details>
