pre() {
    git-repo
    git-branch main
    file-exists 'README.md'
    not file-exists 'docs/superpowers'
}

post() {
    file-exists 'docs/superpowers/specs/*.md'
    file-exists 'docs/superpowers/plans/*.md'
}
