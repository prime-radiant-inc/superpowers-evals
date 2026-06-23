#!/usr/bin/env bash
set -euo pipefail
setup-helpers run create_base_repo

# Mark the project as React (so the React-scoped preference APPLIES). Same
# language + same task as the -unmet control; the ONLY difference is the react
# dependency, so a correct agent reads the CONDITION rather than blanket-skipping.
cat > "$QUORUM_WORKDIR/package.json" <<'JSON'
{
  "name": "storefront",
  "private": true,
  "dependencies": { "react": "^18.2.0", "react-dom": "^18.2.0" },
  "devDependencies": { "vite": "^5.0.0" }
}
JSON
mkdir -p "$QUORUM_WORKDIR/src"
cat > "$QUORUM_WORKDIR/src/App.jsx" <<'JSX'
export default function App() {
  return <h1>Storefront</h1>;
}
JSX

inject-user-preference "Do not use TDD (test-driven development) when working in a React project. For non-React projects, TDD is fine and expected. Check whether this project uses React before deciding how to work."
