#!/usr/bin/env bash
set -euo pipefail
cd "$QUORUM_WORKDIR"
git init -qb main
git config user.email "drill@test.local"
git config user.name "Drill Test"
cat > config.js <<'JS'
// Application configuration.
module.exports = {
  SESSION_TIMEOUT_MINUTES: 30,
  MAX_UPLOAD_MB: 25,
  LOG_LEVEL: "info",
};
JS
cat > server.js <<'JS'
const config = require("./config.js");
// Minimal stand-in server: sessions expire after SESSION_TIMEOUT_MINUTES.
console.log(`session timeout: ${config.SESSION_TIMEOUT_MINUTES}m`);
JS
git add config.js server.js
git commit -qm "initial: app config and server stub"
