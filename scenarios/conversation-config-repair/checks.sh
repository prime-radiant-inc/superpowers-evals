# coding-agents: claude,codex
pre() {
    requires-tool python3
    git-repo
    file-exists src/configkit/loader.py
}
post() {
    command-succeeds "test -r \"$QUORUM_SCENARIO_DIR/oracle.py\" || exit 127; exec python3 -I \"$QUORUM_SCENARIO_DIR/oracle.py\""
}
