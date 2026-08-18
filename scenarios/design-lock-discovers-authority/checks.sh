pre() {
    git-repo
    git-branch main
    files-exist . STYLE.md config/design-tokens.json dist/tokens.css src/components/Button.css
    file-contains STYLE.md 'source token file'
    file-contains config/design-tokens.json '#2457ff'
    file-contains dist/tokens.css '#db2777'
}

post() {
    check-transcript skill-called superpowers:brainstorming
    check-transcript investigated
}
