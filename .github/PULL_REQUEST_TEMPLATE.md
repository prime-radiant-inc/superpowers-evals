<!--
BEFORE SUBMITTING: This repo is the Drill eval harness for superpowers.
It runs agent CLIs in permissive modes and can handle sensitive transcripts.
Low-evidence, speculative, or bundled PRs will be closed.
-->

## What problem are you trying to solve?
<!-- Describe the specific failure, security gap, eval gap, or user-observed behavior.
     "Hardening" or "improving" is not enough on its own. What broke, leaked,
     became unsafe, or produced an unreliable eval signal? -->

## What does this PR change?
<!-- 1-3 sentences. Keep this to the actual files/behavior changed. -->

## Relationship to superpowers
<!-- Explain how this supports the parent superpowers repo.
     If this changes skill behavior, harness loading, or eval methodology,
     describe the expected before/after signal and why it belongs in Drill. -->

## Security and eval-lab checklist
- [ ] This PR does not commit API keys, `.env` files, session logs, `results/`, or other run artifacts
- [ ] This PR does not cause CI to run live agent evals, call model APIs, or require `ANTHROPIC_API_KEY` / `OPENAI_API_KEY`
- [ ] If this touches dangerous-mode backend flags, shell execution, environment inheritance, or log collection, the risk is explained below
- [ ] If this adds or changes a scenario, setup helper, or assertion command, I considered how untrusted input could affect shell execution

Risk notes:
<!-- Required for changes touching backends, setup helpers, assertions, session launch, logs, or verifier input. Otherwise write "N/A". -->

## Existing work
- [ ] I searched for related open and closed PRs/issues/tickets
- Related work: <!-- links or "none found" -->

## Tests
<!-- Paste exact commands and outcomes. At minimum, explain whether these ran:
     uv run ruff check
     uv run ty check
     uv run pytest

     Live `drill run ...` sweeps are not required for every PR and must stay out
     of public CI because they require credentials and permissive agent CLIs. -->

## Human review
- [ ] A maintainer has reviewed the complete proposed diff before merge
