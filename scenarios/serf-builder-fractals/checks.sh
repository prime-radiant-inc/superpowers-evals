# coding-agents: serf
# os: linux

pre() {
    baseline-manifest
    git-repo
    git-branch main
    file-exists 'docs/superpowers/specs/2026-07-01-fractals-cli-design.md'
    file-exists 'docs/superpowers/plans/2026-07-01-fractals-cli.md'
    requires-tool go
}

post() {
    check-transcript skill-called superpowers:subagent-driven-development
    check-transcript tool-called Agent
    git-branch main
    file-exists '**/*_test.go'
    file-exists 'cmd/fractals/main.go'
    command-succeeds 'go test ./...'
    command-succeeds 'go build -o "$QUORUM_RUN_DIR/fractals-bin" ./cmd/fractals'
    command-succeeds '"$QUORUM_RUN_DIR/fractals-bin" --help'
    command-succeeds '"$QUORUM_RUN_DIR/fractals-bin" sierpinski --size 8 --depth 3 --char "#"'
    command-succeeds '"$QUORUM_RUN_DIR/fractals-bin" mandelbrot --width 20 --height 8 --iterations 20'
    command-succeeds '"$QUORUM_RUN_DIR/fractals-bin" julia --width 20 --height 8 --iterations 20'
    command-succeeds '"$QUORUM_RUN_DIR/fractals-bin" burningship --width 20 --height 8 --iterations 20'
    command-succeeds '"$QUORUM_RUN_DIR/fractals-bin" newton --width 20 --height 8 --iterations 20'
    command-succeeds '"$QUORUM_RUN_DIR/fractals-bin" fern --width 20 --height 8 --points 1000 --seed 42 --char "*"'
    not command-succeeds '"$QUORUM_RUN_DIR/fractals-bin" sierpinski --size 0'
    git-count commits gte 15
    git-clean
}
