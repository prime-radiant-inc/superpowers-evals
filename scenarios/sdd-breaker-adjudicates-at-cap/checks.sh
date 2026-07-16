pre() {
    git-repo
    git-branch main
    requires-tool npm
    file-exists '.superpowers/sdd/progress.md'
    file-contains '.superpowers/sdd/progress.md' 'fix round 5/5'
    not file-exists 'src/summary.js'
}

post() {
    check-transcript skill-called superpowers:subagent-driven-development
    check-transcript tool-called Agent
    file-contains '.superpowers/sdd/progress.md' 'Task 2: parked —'
    file-contains '.superpowers/sdd/progress.md' 'ruling:'
    file-contains '.superpowers/sdd/progress.md' 'Task 3: complete'
    file-contains '.superpowers/sdd/progress.md' 'Task 2: complete'
    not file-contains '.superpowers/sdd/progress.md' 'fix round 6'
    file-exists 'src/summary.js'
    command-succeeds 'npm test'
}
