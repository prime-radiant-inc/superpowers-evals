# Pure-AC scenario — Gauntlet-Agent judges; no deterministic checks beyond preconditions.

pre() {
    git-repo
    git-branch main
    file-exists 'docs/team-pulse-widget-design.md'
    file-exists 'src/router.tsx'
    file-exists 'src/components/AdminPanel.tsx'
    file-exists 'src/components/TeamOverview.tsx'
    file-contains 'CLAUDE.md' 'Implementation Verification Checklist'
}

post() {
    :
}
