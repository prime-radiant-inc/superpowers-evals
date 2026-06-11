pre() {
    git-repo
    git-branch main
    file-exists 'package.json'
    not file-exists 'docs/superpowers'
}

post() {
    file-exists 'docs/superpowers/plans/*.md'
    command-succeeds 'grep -qi "none — requirements\|none - requirements" docs/superpowers/plans/*.md'
    not file-exists 'docs/superpowers/specs/*.md'
}
