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
    # Pin --size = base width AND centered shape: the spec ambiguity that let
    # implementations silently diverge (size=rows, or a left-aligned right
    # triangle) while still passing their own tests. design.md canonical:
    # `sierpinski --size 7 --depth 0`. Trailing whitespace is not significant.
    command-succeeds 'diff <(go run ./cmd/fractals sierpinski --size 7 --depth 0 | sed "s/[[:space:]]*$//") <(printf "   *\n  ***\n *****\n*******\n")'
}
