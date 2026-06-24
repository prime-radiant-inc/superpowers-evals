# 2026-06-24: compress-bootstrap release test (4-agent sentinel + main baseline)

**Goal**: release-test the superpowers `compress-bootstrap` branch (a slimmed
SessionStart bootstrap) on the shared quorum appliance — run the sentinel tier
across four coding-agents, baseline the same grid on `main`, and decide whether
the branch regresses any skill-triggering behavior before shipping.

## Config

| Dimension | Value |
|---|---|
| superpowers (under test) | `compress-bootstrap` → `b1864719` |
| superpowers (baseline) | `main` → `896224c4` |
| evals harness | `main`; `75ae750` → `2902723` → `e939254` (two caps landed mid-run, below) |
| gauntlet QA driver | `main` → `2449dfe8` (`claude-sonnet-4-6`, blessed-bundle API key) |
| Coding-agents + credentials | claude→`opus` (claude-opus-4-8); codex→`openai_responses` (gpt-5.5, OpenAI Responses); kimi→`kimi_default` (api-key env); pi→`openrouter_glm_5_2` (GLM 5.2) |
| Tier | `sentinel` |
| Appliance | Terminus `quorum-appliance`, blessed bundle `blessed-20260624T000646Z`, Linux container |

### Run pointers

| Run | Job / batch |
|---|---|
| smoke (claude) | `job-20260624T182419Z-9ba3` — pass, ~$0.26 |
| sentinel claude+codex (parallel) | `job-20260624T194636Z-0cf9` / `batch-…194649Z-763e` — ~$19.56 |
| kimi column | `job-20260624T202645Z-8852` |
| pi column | `job-20260624T204212Z-42e0` |
| codex 2-cell quota re-run (pass) | `job-20260624T212615Z-3fc4` |
| **main baseline (4-agent)** | `job-20260624T213837Z-4fe8` — 37 ✓ / 7 ✗ / 0 ⊘ |
| confirmation cb rep1–3 | `…222708Z-76ef`, `…223242Z-d231`, `…223847Z-ffe8` |
| confirmation main rep1–3 | `…224350Z-24c9`, `…224854Z-6676`, `…225459Z-c604` |

## Appliance auth landscape (operational)

The blessed bundle ships **API keys only** (openai, anthropic, gemini, kimi,
openrouter). **No OAuth/subscription auth is seeded**, so every agent whose
default credential is OAuth/subscription failed at the setup stage:

- codex `codex_sub` → `Codex ChatGPT subscription auth not found at ~/.codex/auth.json`
- pi `pi_default` (oauth) → `no PI_API_KEY and no pi oauth login found at …/.pi/agent/auth.json`

Working credential per agent on the appliance: **claude→`opus`, codex→`openai_responses`,
kimi→`kimi_default`** (the kimi adapter auto-uses the api-key env path whenever
`KIMI_MODEL_API_KEY` is set, regardless of the entry's `auth: oauth`), **pi→`openrouter_glm_5_2`**
(GLM 5.2). Non-default credentials must be passed via `run-all --credentials`;
the appliance `run` subcommand has no credential passthrough.

The appliance serializes runs with a **single host run-lock** — a second
`run`/`run-all` launched while one is active fails instantly
(`appliance_failed: true`, 0-byte logs). Cells parallelize *within* one job, not
across jobs.

## Harness changes landed mid-run

1. `2902723` — raise `openai_responses` `max_concurrency` 1→4 so the codex
   column parallelizes instead of serializing.
2. `e939254` — cap both proxied-endpoint credentials (`openai_responses`,
   `openrouter_glm_5_2`) at 2. (Rationale at the time was throttle hangs; see
   the caveat — the real cause was quota, but 2 is a fine value.)

## Results

### compress-bootstrap grid (sentinel, 4 agents) — all clean, 0 ⊘

| Agent | result |
|---|---|
| claude·opus | 10 ✓ / 2 ✗ |
| codex·gpt5.5 | 10 ✓ / 2 ✗ |
| kimi | 6 ✓ / 4 ✗ |
| pi·GLM5.2 | 9 ✓ / 1 ✗ |

### main baseline (sentinel, 4 agents)

| Agent | main | compress-bootstrap | Δ |
|---|:--:|:--:|:--:|
| claude·opus | 11 ✓ / 1 ✗ | 10 ✓ / 2 ✗ | −1 |
| codex·gpt5.5 | 10 ✓ / 2 ✗ | 10 ✓ / 2 ✗ | 0 |
| kimi | 7 ✓ / 3 ✗ | 6 ✓ / 4 ✗ | −1 |
| pi·GLM5.2 | 9 ✓ / 1 ✗ | 9 ✓ / 1 ✗ | 0 |

Only three cells differ branch-vs-branch:

| Scenario | Agent | main | compress-bootstrap |
|---|---|:--:|:--:|
| `cost-checkbox-over-trigger` | all 4 | ✗ | ✗ |
| `triggering-writing-plans` | claude | ✓ | ✗ |
| `receiving-code-review-pushback` | kimi | ✓ | ✗ |

`cost-checkbox-over-trigger` fails on all four agents on **both** branches → a
pre-existing trivial-task over-trigger of `brainstorming`, **not** introduced by
compress-bootstrap. The other two were taken to a confirmation pass.

## Confirmation: are the 2 candidates regression or variance?

Re-ran claude+kimi × {`triggering-writing-plans`, `receiving-code-review-pushback`}
**3× per branch**. Pass-rate (confirmation reps + original grid samples):

| Cell | compress-bootstrap | main | read |
|---|:--:|:--:|---|
| claude `triggering-writing-plans` | 2/5 | 3/4 | **variance** — flips on both branches |
| kimi `receiving-code-review-pushback` | 0/4 | 2/4 | **flaky** — main itself only ~50% |
| kimi `triggering-writing-plans` | 1/4 | 0/4 | kimi-weak on both, not branch-related |
| claude `receiving-code-review-pushback` | 4/4 | 4/4 | stable pass |

- **claude `triggering-writing-plans` — cleared.** The grid's 2/2 branch fail
  was small-sample noise from the order-sensitive `skill-before-tool` check
  (`writing-plans` before the first `Write`); with reps it flips on both
  branches.
- **kimi `receiving-code-review-pushback` — not a confirmed regression.** Looked
  like a clean branch failure (0/4 on compress-bootstrap) but `main` only passes
  2/4 — the scenario is nondeterministic for kimi. 0/4 vs 2/4 is not
  statistically distinguishable (Fisher's exact p≈0.4). Ruling out a *partial*
  degradation would need ~10+ reps/side; no signal strong enough to block on.

## Verdict

**No confirmed regression in `compress-bootstrap`.** Bootstrap loads on all four
agents, core skill-triggering works, and the two apparent regressions both
dissolved under repetition (one clear variance, one flaky cell). The only
systemic red — trivial-task over-triggering (`cost-checkbox-over-trigger`,
all 4 agents) — is **pre-existing on `main`** and warrants a separate look, but
is not a compress-bootstrap effect. From this sentinel corpus the branch is
clean to ship.

## Negative result / caveat

- **Codex "frozen / no response" hangs were OpenAI quota exhaustion, not
  concurrency throttling.** At `max_concurrency: 4`, 2/12 codex cells hung as
  indeterminate; I first attributed this to endpoint throttling and capped the
  proxied credentials at 2. Re-running the 2 cells at 2 still hung —
  `"Quota exceeded. Check your plan and billing details."` on the bundle's
  `OPENAI_API_KEY`. After a billing top-up the same 2 cells passed cleanly. The
  concurrency cap was a wrong-cause fix (harmless, and 2 is a reasonable value);
  the real lever was account quota. Same key backs `opencode_gpt5`, so opencode
  is similarly exposed.
- **Single-run-each grids over-read variance as regression.** Both branch
  "regressions" came from 1–2 samples on order-sensitive / nondeterministic
  cells. For release decisions, confirm any single-cell branch delta with reps
  before calling it a regression.
