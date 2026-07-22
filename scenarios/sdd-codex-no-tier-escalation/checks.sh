# coding-agents: codex
#
# The Codex counterpart of sdd-round4-escalates-model (which is pinned
# `coding-agents: claude` and must STAY GREEN — on Claude Code the round-4
# escalation ladder is real: haiku -> sonnet+). On Codex the only spawn
# models are gpt-5.6-sol and gpt-5.6-terra, sol-tier subagents are the
# measured spin-out driver (PRI-2672), and the platform reference's role
# table overrides SKILL.md's "one tier above" wording: round 4 means a
# FRESH implementer at the same terra tier, or a BLOCKED escalation to the
# human — never a quiet climb to sol or an effort bump.
#
# Deterministic layer is existential (see sdd-codex-dispatch-pinning):
# it proves a terra-pinned dispatch exists and the loop stayed in bounds.
# "The ROUND-4 dispatch specifically stayed on-tier / no sol dispatch
# anywhere / BLOCKED counts as a pass" are judge-owned distinctions.
# Same container prerequisites as sdd-codex-dispatch-pinning (codex >=
# 0.145.0, multi_agent enabled).

pre() {
    git-repo
    git-branch main
    requires-tool npm
    file-exists '.superpowers/sdd/progress.md'
    file-contains '.superpowers/sdd/progress.md' 'fix round 3/5'
    not file-contains '.superpowers/sdd/progress.md' 'fix round 4'
    not file-exists 'src/summary.js'
}

post() {
    check-transcript skill-called superpowers:subagent-driven-development
    check-transcript tool-called Agent
    check-transcript tool-arg-match Agent --matches 'model,input,prompt=gpt-5\.6-terra'
    check-transcript tool-arg-match Agent --matches 'fork_turns,input,prompt=none' --ignore-case
    not file-contains '.superpowers/sdd/progress.md' 'fix round 6'
    command-succeeds 'npm test'
}
