pre() {
    git-repo
    git-branch main
    file-exists 'src/app.js'
    file-exists 'docs/superpowers/plans/*.md'
}

post() {
    file-contains 'src/app.js' "console\.log\('app started'\)"
    tool-count Agent lte 2
}
