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

## Run matrix

(filled as runs complete; run dirs under `results/`)

| # | Cell | Verdict | Coding cost | Skill detection | Notes |
|---|---|---|---|---|---|
| 1 | superpowers-bootstrap (smoke) | — | — | — | — |

## Status

2026-08-05: trust fixes landed (`main` @ e2ef518), image rebuilt + pinned,
PR clone pinned, probes recorded. **Battery blocked on `OPENROUTER_API_KEY`
in the local credential env** — key requested from the maintainer; no
model-call-dependent step (toolset probe, smoke, battery) has run yet.
