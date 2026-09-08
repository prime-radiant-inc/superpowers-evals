# coding-agents: claude,codex
pre() {
    requires-tool node
    requires-tool python3
    file-exists src/ratelimit/limiter.py
}

post() {
    command-succeeds "test -r \"$QUORUM_SCENARIO_DIR/oracle.cjs\" || exit 127; exec node \"$QUORUM_SCENARIO_DIR/oracle.cjs\""
}
