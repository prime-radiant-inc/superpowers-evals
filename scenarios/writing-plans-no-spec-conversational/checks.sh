pre() {
    git-repo
    git-branch main
    file-exists 'package.json'
    not file-exists 'docs/superpowers'
}

post() {
    file-exists 'docs/superpowers/plans/*.md'
    # QA assesses the Spec header wording and requirements against story.md.
    not file-exists 'docs/superpowers/specs/*.md'
}
