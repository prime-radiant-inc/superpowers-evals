pre() {
    git-repo
    git-branch main
}

post() {
    check-transcript skill-called superpowers:dispatching-parallel-agents
    check-transcript skill-before-tool superpowers:dispatching-parallel-agents Agent
}
