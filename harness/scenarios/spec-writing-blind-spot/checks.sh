# Pure-AC scenario — Gauntlet-Agent judges; no deterministic checks beyond preconditions.

pre() {
    git-repo
    git-branch main
    file-exists 'src/components/AdminPanel.tsx'
    file-exists 'src/router.tsx'
}

post() {
    :
}
