# Hermes PR #2025 merge-confidence campaign

Date: 2026-08-05.
Spec: `docs/superpowers/specs/2026-08-05-hermes-pr2025-merge-confidence-design.md` (v2).
Plan: `docs/superpowers/plans/2026-08-05-hermes-pr2025-merge-confidence.md`.
Subject: **`pull/2025/head @ b6613057ae5cb1ecb634f12e52cc47a260caf0e4`**
(obra/superpowers #2025, `hermes-harness-rebase`; identified by SHA only —
the PR's `plugin.yaml` version string is stale and would misdate evidence).

## Hypothesis

The PR's `pre_llm_call` first-turn bootstrap + native `register_skill`
mechanism produces skill-compliant behavior across skill types, persists to
later turns (`api_content` replay), and the July n=1 GREEN was not a fluke —
on the current hermes CLI (v0.20.0), not the v0.19.0 it was proven on.

## Provenance

- Superpowers under test: dedicated clone `../superpowers-pr2025`, detached
  @ `b6613057ae5cb1ecb634f12e52cc47a260caf0e4`.
- Harness: superpowers-evals `main` @ `e2ef518` (trust fixes d5e0f1b, 5640741,
  d629f93; scenario 0fe3539; Dockerfile pin b506aab).
- Image: `superpowers-evals:local` = `f5cb05f77030` (rebuilt 2026-08-05 with
  `HERMES_COMMIT=9ea01979dc00d3ed0b08977c28325e6c3ed592d0`); fallback retag
  `superpowers-evals:pre-hermes20-v0190` = `d287f27ed417` (the July-GREEN
  v0.19.0 image).
- `hermes version` (in-image, full line): `Hermes Agent v0.20.0 (2026.8.3) ·
  upstream 55e70f57 · local 9ea01979 (+20831 carried commits)`; install
  `/usr/local/lib/hermes-agent`, method git, Python 3.11.15, OpenAI SDK
  2.24.0. `hermes --version` first line matches (`Hermes Agent v0.20.0
  (2026.8.3)`).
- CLI version discipline: NO standing `pin_cli_version` in `hermes.yaml` —
  per the a1287aa policy (2026-08-04, codex precedent) the image pins by
  construction (`HERMES_COMMIT`) and a standing yaml pin is a third authority
  that drifts. The campaign's hard assertion is instead: every counted run's
  `provenance.agent_cli_version` must equal the version line above, checked
  at triage.
- Gauntlet: `$GAUNTLET_ROOT` (`../gauntlet`) @
  `0a0bc916f320037c8ef53a5a91ba6903db68377c` (includes the grader token-cap
  fix). Grader model: harness-pinned `claude-sonnet-5`.
- Credential: `openrouter_glm_5_2` (`z-ai/glm-5.2` via OpenRouter,
  `OPENROUTER_API_KEY`). Provider routing uncontrolled and unrecorded.
- `evals-tool-versions` snapshot highlights: claude 2.1.209, codex-cli
  0.146.0, bun 1.3.14, node v22.23.2. (Full snapshot rerun available via
  `docker run --rm superpowers-evals:local evals-tool-versions`; its bare
  `docker run` quorum self-probe fails by design — `/workspace/evals` is
  mounted only at `up`.)
- Real-install probe: `hermes plugins install --help` accepts only a Git URL
  or owner/repo shorthand — **no branch/ref option** — so the real
  `plugins install obra/superpowers` smoke is structurally impossible before
  the PR merges to the default branch. The post-merge deferral stands as the
  documented consequence of this probe, not an assumption.

## Decision rules (pre-registered before run 1)

- superpowers-bootstrap: pass = ≥2/3. The v0.20 smoke counts as run 1 iff its
  capture is intact, regardless of verdict.
- RED arm (neutered pre_llm_call) must FAIL; if it passes, all greens are
  void (native skill registration is carrying the scenario).
- triggering-*: n=1 screen. Any fail → that cell escalates to n=3 AND gets a
  same-hour paired pi run (same scenario, same credential):
  hermes-fail + pi-pass ⇒ delivery mechanism; hermes-fail + pi-fail ⇒ model.
- Every fail: check `~/.hermes/logs/agent.log` for compaction before it
  counts as PR evidence.
- Every skill-called pass: record whether `Skill` (skill_view) or the `Read`
  fallback matched. Majority-fallback greens falsify native registration.
- Every counted run: `provenance.superpowers_rev` == `b6613057…` and
  `provenance.agent_cli_version` == the version line above.
- Reporting: existence proofs only, no reliability rates from n≤3; compaction
  untested by design; GLM-5.2-only; OpenRouter provider routing uncontrolled.

## Toolset probe (2026-08-05, in-container, one live --yolo session)

Session `20260805_230601_8dc20c` (scratch HOME, subagent-create + self-edit
task). Native tool names observed: `delegate_task`, `process`, `read_file`,
`patch` — **`delegate_task` and `patch` confirmed as the real v0.20 names**,
matching the shipped `HERMES_TOOL_MAP`. `process` is background-process
control (poll/wait/kill for `terminal(background=true)`, per
`tools/process_registry.py`), not the shell executor — correctly unmapped;
`terminal` remains the shell (`tools/terminal_tool.py` present). Subagent
dispatch minted **no child session** (`sessions list` and the export both show
exactly one), and the session's `estimated_cost_usd` (0.0201) covers the whole
run including the delegated work — the `mergeTrajectories` multi-session
under-count concern does not apply to hermes; no merge fix needed. Export
carries `model: z-ai/glm-5.2` and `billing_provider: openrouter`, the exact
fields the normalizer fix stamps. `mid-conversation-skill-invocation` stays in
the battery (subagent tool exists).

## Run matrix

(run dirs under `results/`; provenance gate = superpowers_rev `b661305…` +
CLI `Hermes Agent v0.20.0 (2026.8.3)`, both verified per counted run)

| # | Cell | Verdict | Coding cost | Skill detection | Notes |
|---|---|---|---|---|---|
| 1 | superpowers-bootstrap (smoke = run 1) | **PASS** 3/3 pre, 3/3 post | $0.027 / 135K, priced | native `Skill` (skill_view) | `…230752Z-76d1`; v0.20.0 needs no fallback; economics fix live-verified |
| C | RED arm (neutered `pre_llm_call` → None) | **FAIL** (required) | $0.03 / 126K | none — Write fired with no skill load | `…231013Z-f65f`; `superpowers_dirty: true` expected (the neuter edit); control discriminates on today's CLI/model — greens are meaningful |

Battery (10 further runs, sequential, 23:11–23:42Z; every run passed the
provenance gate, every run priced — no unpriced models anywhere):

| # | Cell | Verdict | Coding cost | Skill detection | Notes |
|---|---|---|---|---|---|
| 2 | superpowers-bootstrap (run 2) | **PASS** 3/3 | $0.032 | native `Skill` | `…231628Z-24d5` |
| 3 | superpowers-bootstrap (run 3) | **PASS** 3/3 | $0.025 | native `Skill` | `…234147Z-ed12` — bootstrap cell final: **3/3 ≥ 2/3 ⇒ PASS** |
| 4 | superpowers-bootstrap-persistence | **PASS** 3/3 | $0.038 | native `Skill` | `…231729Z-dd35` — turn-2 naive trigger loaded brainstorming: **`api_content` replay behaviorally proven** |
| 5 | mid-conversation-skill-invocation | **PASS** | $0.128 | native `Skill` | `…233828Z-97fe` — `tool-called Agent` fired via the new `delegate_task` mapping |
| 6 | triggering-test-driven-development | fail | $0.024 | Skill (wrong one) | loaded BUNDLED `test-driven-development` (see collision analysis) |
| 7 | triggering-requesting-code-review | fail | $0.074 | Skill (wrong one) | loaded BUNDLED `requesting-code-review` |
| 8 | triggering-finishing-a-development-branch | fail | $0.090 | Skill (wrong one) | loaded BUNDLED `github-pr-workflow` |
| 9 | triggering-executing-plans | fail | $0.072 | Skill (wrong one) | loaded BUNDLED `plan` + `subagent-driven-development` |
| 10 | triggering-writing-plans | fail | $0.046 | none | silent — no skill loaded at all; the one cell that gets the full pre-registered escalation |
| 11 | triggering-systematic-debugging | ⊘ indeterminate | $0.029 | Skill (wrong one) | Gauntlet did not complete (investigate); loaded BUNDLED `systematic-debugging`; re-screened below |
| 12 | triggering-dispatching-parallel-agents | ⊘ indeterminate | $0.130 | none | Gauntlet ran out of budget (10m45s); re-screened below |

## Collision analysis — the campaign's headline finding

Every skill-detection green in the battery is a **native `skill_view` call —
zero Read-fallback greens** — so the PR's native-registration claim is
isolated and confirmed. But 5 of the 7 triggering cells show the agent
loading a **same-named or near-named skill from hermes' own bundled
library**: the run homes' `~/.hermes/skills/software-development/` ships
`test-driven-development`, `systematic-debugging`, `requesting-code-review`,
`plan`, `spike`, `simplify-code` — name-for-name twins of superpowers
vocabulary. Transcript proof (run `…231349Z-66f3`):
`skill_view("test-driven-development")` returned
`description: "TDD: enforce RED-GREEN-REFACTOR, tests before code."` with
`related_skills: ["systematic-debugging", "plan",
"subagent-driven-development"]` — hermes' bundled skill, not superpowers'.

Attribution: under weak cues the model consults hermes'
`<available_skills>` catalog, recognizes the right *concept* (it reached for
a TDD skill exactly when TDD was warranted), and resolves the **bare bundled
name** instead of the plugin-registered `superpowers:X`. This is neither a
delivery failure (bootstrap 3/3 + persistence + RED control prove delivery)
nor pure gate disobedience (the concept triggered) — it is a **namespace
collision that out-competes the plugin's skills on hermes specifically**.

Upstream recommendation for PR #2025: the finding, not a blocker — the
mechanism the PR ships works as designed. Options obra could weigh:
bootstrap prose steering ("prefer superpowers:X over similarly-named bundled
skills"), or hermes-side dedup/priority when a plugin registers a
same-concept skill. Recorded here; nothing posted to the PR without
maintainer say-so.

**Pre-registered-rule deviation, stated plainly:** the escalation rule
(n=3 + paired pi on any triggering fail) existed to attribute fails that are
silent by construction. The five collision fails are not silent — the
transcripts carry positive evidence of the alternative cause, and a pi pair
cannot speak to a collision mechanism pi does not have (no bundled twin
library). Escalation for those five is therefore waived as purchased-already;
`triggering-writing-plans` (genuinely silent) keeps its full escalation, and
both indeterminates get fresh screens. This is a deviation from the letter of
the rules in service of their purpose, decided before any escalation ran.

## Escalation (pre-registered; 23:46–23:58Z)

| Cell | Run | Verdict | Skills loaded | Meaning |
|---|---|---|---|---|
| triggering-writing-plans, hermes n2 | `…4613Z-63c3` | fail | bundled `plan` | the "silent" cell exhibits the same collision on re-run |
| triggering-writing-plans, **pi pair** | `…4939Z-37f1` | **PASS** | (pi-native path) | **same model, same credential, passes ⇒ hermes-environment-attributed, not model** |
| triggering-writing-plans, hermes n3 | `…5219Z-a672` | fail | none | cell final 0/3 |
| triggering-systematic-debugging re-screen | `…5424Z-0836` | fail | bundled `systematic-debugging` | collision, deterministic across both attempts |
| triggering-dispatching-parallel-agents re-screen | `…5540Z-dc29` | fail | none | gauntlet completed this time; silent miss |

Footnote: the pi pair's coding cost printed $0.00 (66K tokens) — a pi
credential-override pricing quirk worth a look someday, out of scope here.

## Verdict

**Merge-supporting for PR #2025's mechanism.** Every claim the PR makes was
verified behaviorally on the current CLI (v0.20.0), each priced, each
provenance-gated, with a discriminating RED control:

1. **Bootstrap delivery:** 3/3 PASS (pre-registered bar ≥2/3).
2. **Cross-turn persistence (`api_content` replay):** PASS on the new
   two-turn naive probe — the only run shape that can observe it.
3. **Native skill registration:** every green used a native `skill_view`
   call; zero Read-fallback greens across the campaign.
4. **Subagent dispatch + tool mapping:** PASS (`delegate_task` → `Agent`
   live-verified).
5. **RED control (neutered `pre_llm_call`):** FAIL as required — greens mean
   the mechanism, not scenario laxity.

**Not a blocker, but the finding obra should see:** on hermes, superpowers'
gate-invocation under weak cues (the `triggering-*` family, 0/7) loses a
namespace race to hermes' own bundled skill library, which ships
name-for-name twins (`test-driven-development`, `systematic-debugging`,
`requesting-code-review`, `plan`, `github-pr-workflow` adjacent). The model
triggers on the right concept and loads the wrong provider's skill. The
same-model pi control passing places the cause in the hermes environment,
not GLM 5.2. Scope limits: existence proofs only (n≤3); compaction untested
by design (hermes has no post-compaction hook — documented PR limitation);
GLM-5.2-only; provider routing uncontrolled.

Campaign spend: 18 runs (1 smoke + 1 RED + 10 battery + 5 escalation + 1
toolset probe session), ≈ $4.75 total (gauntlet ≈ $3.75, coding ≈ $1.00).

## Post-campaign provider-serving isolation (2026-08-05, local)

Maintainer manual testing could not reproduce the collision, which forced a
proper isolation. Fixed everything (machine = maintainer's Mac, hermes
v0.20.0, plugin from the same PR head, same bundled twins present in
`~/.hermes/skills/software-development/`, same fixture + naive
"returns the wrong date on the last day of the month" cue, fresh session per
sample) and varied ONLY the serving path for `z-ai/glm-5.2`:

| Arm | skill_view calls | Namespace held |
|---|---|---|
| GLM via **Nous Portal** (`--provider nous`, maintainer default) | `superpowers:systematic-debugging` ×3 | **3/3** |
| GLM via **OpenRouter** (`--provider openrouter`, same key as harness) | namespaced ×1, bare `systematic-debugging` ×2 | 1/3 |
| (campaign harness runs, GLM via OpenRouter, sterile env) | bare ×2 | 0/2 |

Pooled: Nous-served 3/3 vs OpenRouter-served 1/5. Small n, but the variable
that moves the outcome is the provider, in the same environment, same model
id. **Re-attribution of the campaign headline:** the root cause is not a
hermes-specific selection bug — OpenRouter's routed GLM serving (provider/
quantization uncontrolled per request) degrades the model's namespace
discipline, and hermes' bundled twin catalog converts each dropped
`superpowers:` prefix into a wrong-skill load. On harnesses without twin
names (pi), a dropped prefix has nothing to collide with — hence the pi
control's pass.

Consequences:
- For PR #2025: mechanism verdict unchanged (merge-supporting). The
  namespace-discipline bootstrap line is still cheap hardening for
  weak-serving cases, but the primary user guidance is **provider quality**:
  Nous-Portal-served GLM held discipline 3/3.
- For quorum: `openrouter_glm_5_2`'s uncontrolled routing is now a
  *demonstrated* behavioral variable, not a theoretical one — triggering-*
  results on this credential carry serving noise for hermes (and plausibly
  pi/opencode). Consider provider pinning in the credential when OpenRouter
  supports it, and record served-provider metadata when available.
- The brainstorm→writing-plans→SDD spine is expected robust either way
  (chained skills carry explicit names); spine run pending below.

## Status

2026-08-05: CAMPAIGN COMPLETE (verdict above). Housekeeping still open:
- `OPENROUTER_API_KEY` was sourced from the **appliance blessed bundle** into
  local `.env` (0600); plaintext copies now sit in ~17 run homes under
  `results/`. Rotation is an appliance-wide decision (it would break the
  shared bundle until reseeded) — maintainer's call, flagged.
- Container is up against `../superpowers-pr2025`; the neutered RED copy
  lives at `../superpowers-pr2025-red` (keep until the PR merges, then both
  go).
- Nothing posted to PR #2025 — maintainer decides whether/what to comment.
