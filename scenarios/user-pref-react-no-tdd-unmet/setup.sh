#!/usr/bin/env bash
set -euo pipefail
setup-helpers run create_base_repo

# A plainly NON-React Node project (no react dependency), so the React-scoped
# preference must NOT apply. Same language + same task as the -met cell; the ONLY
# difference is the absent react dependency.
cat > "$QUORUM_WORKDIR/package.json" <<'JSON'
{
  "name": "duration-cli",
  "private": true,
  "bin": { "duration": "src/cli.js" },
  "dependencies": { "commander": "^12.0.0" }
}
JSON
mkdir -p "$QUORUM_WORKDIR/src"
cat > "$QUORUM_WORKDIR/src/cli.js" <<'JS'
#!/usr/bin/env node
// duration-cli — a small Node command-line tool (not a React app).
JS

inject-user-preference "Do not use TDD (test-driven development) when working in a React project. For non-React projects, TDD is fine and expected. Check whether this project uses React before deciding how to work."
