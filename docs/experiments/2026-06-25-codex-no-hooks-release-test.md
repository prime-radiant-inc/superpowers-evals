# 2026-06-25: f/codex-no-hooks release test (+ global-tool-mapping fixture fix)

**Goal**: release-test the superpowers `f/codex-no-hooks` branch on the shared
quorum appliance — 4-agent sentinel grid diffed against the `main` baseline.
Follow-on to [`2026-06-24-compress-bootstrap-release-test.md`](2026-06-24-compress-bootstrap-release-test.md),
reusing that campaign's appliance setup (working credentials, agent mapping).

The branch turned out to be broader than its name: besides codex hook/marketplace
changes it **reorganizes the `using-superpowers` tool references** — deleting
`claude-code-tools.md` (+ copilot, gemini), keeping/updating `codex-tools.md`,
`pi-tools.md`, `antigravity-tools.md`. That removal is intentional (Claude Code
is the native platform the action language is written for; it ships no mapping
file), and it surfaced a stale eval scenario, fixed here.

## Config

| Dimension | Value |
|---|---|
| superpowers (under test) | `f/codex-no-hooks` → `367f0e81` |
| superpowers (baseline) | `main` → `896224c4` (reused from the 06-24 campaign) |
| evals harness | `main` → `1939fbf` (incl. `41a8bb8` proxied-conc 5, `1939fbf` scenario fix) |
| Coding-agents + credentials | claude→`opus`; codex→`openai_responses` (gpt-5.5); kimi→`kimi_default` (api-key env); pi→`openrouter_glm_5_2` (GLM 5.2) |
| Tier | `sentinel` |

### Run pointers

| Run | Job |
|---|---|
| f/codex-no-hooks 4-agent grid | `job-20260625T004741Z-edaa` — 33 ✓ / 11 ✗ / 0 ⊘ |
| main baseline (reused) | `job-20260624T213837Z-4fe8` |
| kimi triggering-tdd confirm (f ×3) | `…012621Z-eb09`, `…013750Z-5030`, `…014033Z-95c8` |
| kimi triggering-tdd confirm (main ×3) | `…014336Z-07bf`, `…014640Z-4b0a`, `…015003Z-707b` |
| global-tool-mapping fix validation | `job-20260625T015353Z-46e5` — all 4 ✓ |

## Results — grid vs main

| Agent | main | f/codex-no-hooks | Δ |
|---|:--:|:--:|:--:|
| **codex**·gpt5.5 | 10 ✓ / 2 ✗ | **10 ✓ / 2 ✗** | **0 — identical** |
| pi·GLM5.2 | 9 ✓ / 1 ✗ | 9 ✓ / 1 ✗ | 0 |
| claude·opus | 11 ✓ / 1 ✗ | 9 ✓ / 3 ✗ | −2 |
| kimi | 7 ✓ / 3 ✗ | 5 ✓ / 5 ✗ | −2 |

Cells that differed, and what each turned out to be:

| Scenario | Agent(s) | classification |
|---|---|---|
| `global-tool-mapping-comprehension` | claude | **stale test fixture** — branch removed `claude-code-tools.md` (see fix) |
| `triggering-writing-plans` | claude | known variance (proved in 06-24 campaign) |
| `receiving-code-review-pushback` | kimi | known flaky (~50% on main) |
| `triggering-test-driven-development` | kimi | **variance** — confirmed below |

**codex — the branch's actual target — is identical to `main`.** `superpowers-bootstrap`
passes (auto-triggers brainstorming, hook configured), `codex-tool-mapping` passes
(its reference was kept). No codex regression; 0 indeterminates.

## Root-cause: claude `global-tool-mapping` is a fixture mismatch, not a regression

Gauntlet on the claude fail: *"criterion 1 fails because the claude-code-tools.md
file does not exist in the fixture… The agent correctly searched, found it missing,
rationalized that Claude Code is the native platform requiring no mapping file…
This is a fixture issue."*

The scenario's AC required **every** agent to read its platform's `*-tools.md`. But
superpowers only ships reference files for harnesses listed under using-superpowers'
Platform Adaptation (codex, pi, antigravity). claude (native), kimi, copilot, gemini
have none — and **kimi was already failing this on `main`** for the same reason
(no `kimi-tools.md` ever existed; it dispatched correctly via `Agent`, only the
missing-file criterion failed).

### Fix (`1939fbf`)
Made AC1 platform-aware: read the `*-tools.md` only when one exists for the agent's
platform; otherwise pass on correct native-tool dispatch. Deterministic floor
(`tool-called Agent`) unchanged; prompt + operator note no longer assume a file
exists.

**Validated live** (`job-20260625T015353Z-46e5`, on `f/codex-no-hooks`):

| Agent | before fix | after fix | how it passes |
|---|:--:|:--:|---|
| claude | ✗ | ✓ | recognizes native, no file → dispatches via `Agent` |
| kimi | ✗ | ✓ | same (no `kimi-tools.md`) |
| codex | ✓ | ✓ | still reads `codex-tools.md` first |
| pi | ✓ | ✓ | still reads `pi-tools.md` first |

codex/pi Gauntlet summaries confirm they still consult their files before
dispatching — the fix corrects the false negatives without loosening the test for
file-having platforms.

## kimi `triggering-tdd` — variance, not a regression

3 reps/branch + grid sample:

| Branch | samples | result |
|---|---|---|
| main | 4 | pass ×4 |
| f/codex-no-hooks | 4 | pass ×2, fail ×1 (grid), indeterminate ×1 → 2/3 valid pass |

The grid fail was noise; kimi passes the cell on the branch. No branch effect.

## Verdict

**No real regression in `f/codex-no-hooks`.** The branch's codex target is identical
to `main`; the eval-visible deltas were one **stale test** (now fixed — the
intentional `claude-code-tools.md` removal) plus **known variance** cells. With the
fixture fix applied, the branch matches `main` across all four agents.

## Negative result / caveat

- **`global-tool-mapping-comprehension` was silently wrong for no-file platforms
  the whole time** — kimi had been failing it on every branch for a file that never
  existed. The branch didn't break the scenario; it exposed an existing fixture bug.
  Lesson: a scenario that enumerates platform artifacts (per-platform files) rots
  when superpowers reorganizes those artifacts; prefer "read it if present" over
  "every platform has one."
- Proxied-endpoint concurrency was raised back to 5 (`41a8bb8`) after confirming the
  earlier codex hangs were OpenAI quota, not throttling (see the 06-24 caveat).
