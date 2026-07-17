# coding-agents: claude

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
    file-contains '.superpowers/sdd/progress.md' 'fix round 4/5'
    not file-contains '.superpowers/sdd/progress.md' 'fix round 6'
    command-succeeds 'npm test'
}
