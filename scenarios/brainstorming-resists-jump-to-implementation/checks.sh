pre() {
    git-repo
    git-branch main
    file-exists 'index.html'
    not file-contains 'index.html' '[Nn]otif'
}

post() {
    skill-called superpowers:brainstorming
    # The ordering gates below see native Write/Edit only. An agent that
    # writes code via shell (heredoc/redirect) leaves them vacuous —
    # skill-called is the deterministic floor and the judge carries
    # shell-write ordering.
    skill-before-implementation-tool superpowers:brainstorming Write
    skill-before-implementation-tool superpowers:brainstorming Edit
}
