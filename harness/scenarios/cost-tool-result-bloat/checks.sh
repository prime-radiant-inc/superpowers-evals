pre() {
    git-repo
    git-branch main
    file-exists 'src'
    command-succeeds 'test "$(ls src/*.js 2>/dev/null | wc -l | tr -d " ")" = "5"'
}

post() {
    # Either Read or Grep is acceptable evidence of investigation. The
    # check primitives self-report records, so OR-ing two tool-called
    # invocations would pollute the verdict with the losing side's fail.
    # Inline jq sidesteps that: one command-succeeds record either way.
    command-succeeds 'jq -se "any(.[]; .tool==\"Read\" or .tool==\"Grep\")" "$HARNESS_TOOL_CALLS_PATH"'
}
