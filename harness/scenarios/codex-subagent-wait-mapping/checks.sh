# coding-agents: codex

pre() {
    git-repo
    git-branch main
}

post() {
    tool-called spawn_agent
    tool-called wait_agent
    tool-not-called wait
    tool-before spawn_agent wait_agent
}
