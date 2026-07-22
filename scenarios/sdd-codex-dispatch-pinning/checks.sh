# coding-agents: codex
#
# Codex's spawn_agent is aliased to canonical "Agent" by CODEX_TOOL_MAP in
# src/normalize/codex.ts. Depending on the rollout shape (direct
# MultiAgentV2 tool calls vs 5.6-era unified `exec` segments), the
# normalized Agent call carries either structured spawn args or the raw
# call segment under `input`/`prompt` — the comma-fallback key lists below
# match both shapes.
#
# tool-arg-match is EXISTENTIAL (passes if any one call matches), so the
# deterministic layer below proves that pinned dispatches exist — at least
# one dispatch carrying fork_turns "none", one naming gpt-5.6-terra, one
# naming a reasoning effort. The universal ACs ("EVERY dispatch pins",
# "no dispatch names sol", "no silent inheritance") cannot be counted by
# any trace verb and are judge-owned, as is the 0.144-schema
# indeterminate carve-out (see story.md). This mirrors the
# deterministic/judge split documented in sdd-final-review-single-wave.
#
# HARD PREREQUISITE (see docs/experiments/2026-07-22-codex-spinout-red-
# recipe.md): the container must run codex >= 0.145.0 (container/Dockerfile
# currently pins 0.144.4, whose spawn_agent has NO model/reasoning_effort
# parameters — this scenario would grade wrong there) with
# `features.multi_agent = true` staged into the cell's codex config.

pre() {
    git-repo
    git-branch main
    requires-tool npm
    file-exists '.superpowers/sdd/progress.md'
    file-contains '.superpowers/sdd/progress.md' 'fix round 1/5'
    not file-contains '.superpowers/sdd/progress.md' 'fix round 2'
    not file-exists 'src/summary.js'
}

post() {
    check-transcript skill-called superpowers:subagent-driven-development
    check-transcript tool-called Agent
    check-transcript tool-arg-match Agent --matches 'fork_turns,input,prompt=none' --ignore-case
    check-transcript tool-arg-match Agent --matches 'model,input,prompt=gpt-5\.6-terra'
    check-transcript tool-arg-match Agent --matches 'reasoning_effort,input,prompt=high|medium'
    file-contains '.superpowers/sdd/progress.md' 'Task 3'
    command-succeeds 'npm test'
}
