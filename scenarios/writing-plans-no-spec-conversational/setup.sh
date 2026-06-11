#!/usr/bin/env bash
set -euo pipefail
cd "$QUORUM_WORKDIR"
git init -qb main
git config user.email "drill@test.local"
git config user.name "Drill Test"
cat > package.json <<'JSON'
{
  "name": "tinytool",
  "version": "1.4.2",
  "bin": { "tinytool": "./cli.js" }
}
JSON
cat > cli.js <<'JS'
#!/usr/bin/env node
// tinytool: stub CLI. Supported flags: --help
if (process.argv.includes("--help")) {
  console.log("usage: tinytool [--help]");
  process.exit(0);
}
console.log("tinytool: nothing to do");
JS
git add package.json cli.js
git commit -qm "initial: tinytool CLI stub"
