# coding-agents: claude,codex
pre() {
    requires-tool node
    file-exists src/pricing.js
}

post() {
    command-succeeds "test -r \"$QUORUM_SCENARIO_DIR/oracle.cjs\" || exit 127; exec node \"$QUORUM_SCENARIO_DIR/oracle.cjs\""
}
