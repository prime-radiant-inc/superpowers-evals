# coding-agents: codex
#
# Codex's spawn_agent is aliased to canonical "Agent" by CODEX_TOOL_MAP
# in quorum/normalizers.py; the checks below use the post-alias name.
# wait_agent and wait are NOT aliased — checking them by their raw
# codex names is still the right form.

pre() {
    git-repo
    git-branch main
}

post() {
    check-transcript tool-called Agent
    check-transcript tool-called wait_agent
    check-transcript tool-not-called wait
    check-transcript tool-before Agent wait_agent
}
