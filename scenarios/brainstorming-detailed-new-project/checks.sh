# coding-agents: claude,codex
pre() {
    git-repo
    file-exists README.md
    not file-exists Dockerfile
    not file-exists AGENTS.md
}

post() {
    check-transcript skill-called superpowers:brainstorming
    check-transcript skill-before-implementation-tool superpowers:brainstorming Write
    check-transcript skill-before-implementation-tool superpowers:brainstorming Edit
    not file-exists Dockerfile
}
