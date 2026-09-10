# coding-agents: claude,codex,pi

pre() {
    git-repo
    git-branch main
    assert-checkout-clean
}

post() {
    check-transcript skill-called superpowers:diagnosing-superpowers
    command-succeeds "QUORUM_WORKDIR=\"$PWD\" QUORUM_AGENT_CONFIG_DIR=\"$QUORUM_AGENT_CONFIG_DIR\" bun \"$QUORUM_REPO_ROOT/src/cli/diagnosis-fixtures.ts\" verify \"$QUORUM_SCENARIO_DIR/history/$QUORUM_CODING_AGENT/manifest.json\" \"$QUORUM_SCENARIO_DIR/history/$QUORUM_CODING_AGENT\""
}
