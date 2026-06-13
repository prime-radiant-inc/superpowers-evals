pre() {
    git-repo
    git-branch main
    git-count commits eq 2
    file-exists 'src/db.js'
    file-contains src/db.js '\+ email \+'
    file-contains src/db.js 'function hash\(s\) \{[[:space:]]*return s'
}

post() {
    check-transcript skill-called superpowers:requesting-code-review
    check-transcript tool-called Agent
}
