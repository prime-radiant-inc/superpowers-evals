pre() {
    git-repo
    git-branch main
    file-exists '.superpowers/sdd/progress.md'
    file-contains '.superpowers/sdd/progress.md' 'fix round 5/5'
    file-contains '.superpowers/sdd/progress.md' 'milliseconds'
    not file-exists 'src/summary.js'
}

post() {
    check-transcript skill-called superpowers:subagent-driven-development
    not file-exists 'src/summary.js'
    not file-contains '.superpowers/sdd/progress.md' 'Task 3: complete'
    not file-contains '.superpowers/sdd/progress.md' 'fix round 6'
}
