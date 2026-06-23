pre() {
    git-repo
    git-branch main
}

post() {
    # Deterministic floor: the agent dispatched a subagent via the mapped tool.
    # (Normalizers alias each harness's spawn tool to canonical `Agent`.)
    # "read the correct *-tools.md first" + "reported GLOBALMAP_OK" are graded by
    # the Gauntlet-Agent against the story's Acceptance Criteria.
    check-transcript tool-called Agent
}
