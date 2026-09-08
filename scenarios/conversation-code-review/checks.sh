# coding-agents: claude,codex
pre() {
    requires-tool node
    git-repo
    git-branch main
    git-count commits eq 2
    command-succeeds "test -r \"$QUORUM_SCENARIO_DIR/oracle.cjs\" || exit 127; exec node \"$QUORUM_SCENARIO_DIR/oracle.cjs\""
}

post() {
    command-succeeds "test -r \"$QUORUM_SCENARIO_DIR/oracle.cjs\" || exit 127; exec node \"$QUORUM_SCENARIO_DIR/oracle.cjs\""
}
