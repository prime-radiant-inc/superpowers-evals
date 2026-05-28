pre() {
    git-repo
    git-branch main
    file-exists 'src'
    command-succeeds 'test "$(ls src/*.js 2>/dev/null | wc -l | tr -d " ")" = "5"'
}

post() {
    # `investigated` passes on a native Read/Grep (Claude) OR a shell
    # grep/rg (Codex). The previous inline `jq any(.tool=="Read" or
    # "Grep")` was Claude-only and false-failed every Codex run, since
    # Codex greps via Bash and emits zero native Read/Grep calls.
    investigated
}
