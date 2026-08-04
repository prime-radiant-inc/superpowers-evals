# coding-agents: codex
# Pinned to codex: this scenario ships a codex.config.toml fragment setting
# model_context_window, and only the codex provisioner consumes that knob —
# the forced-compaction premise does not exist on other harnesses.

pre() {
    git-repo
    git-branch main
    requires-tool node
    file-exists 'docs/superpowers/plans/util-plan.md'
}

post() {
    check-transcript skill-called superpowers:subagent-driven-development
    check-transcript tool-called Agent
    command-succeeds 'node --test'
    file-contains 'src/slugify.js' 'function slugify'
    file-contains 'src/clamp.js' 'function clamp'
    file-contains 'src/chunk.js' 'function chunk'
    file-contains 'src/titleCase.js' 'function titleCase'
}
