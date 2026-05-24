# coding-agents: codex

pre() {
    git-repo
    git-branch main
}

post() {
    codex-native-hook-configured
    skill-called superpowers:brainstorming
}
