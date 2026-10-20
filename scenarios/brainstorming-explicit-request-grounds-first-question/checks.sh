# coding-agents: claude,codex
pre() {
    git-repo
    file-exists ledger/cli.py
    file-exists ledger/db.py
    not file-exists AGENTS.md
}

post() {
    # Positive anchor: the ordering checks are vacuous if the skill never fired.
    check-transcript skill-called superpowers:brainstorming
    check-transcript investigated
    check-transcript skill-before-implementation-tool superpowers:brainstorming Write
    check-transcript skill-before-implementation-tool superpowers:brainstorming Edit
    command-succeeds 'git diff --quiet HEAD -- ledger tests'
}
