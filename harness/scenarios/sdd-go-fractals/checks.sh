pre() {
    git-repo
    git-branch main
    file-exists 'plan.md'
    file-exists 'design.md'
    requires-tool go
}

post() {
    skill-called superpowers:subagent-driven-development
    tool-called Agent
    file-exists '**/*_test.go'
    command-succeeds 'go test ./...'
    file-exists 'cmd/fractals/main.go'
    git-count commits gte 4
}
