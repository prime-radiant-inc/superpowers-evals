# coding-agents: codex

pre() {
    git-repo
    git-branch main
}

post() {
    codex-native-hook-configured
    check-transcript skill-called superpowers:brainstorming
}
