pre() {
    git-repo
    git-branch main
    file-exists 'src/textkit/chunking.py'
    file-exists 'tests/test_chunking.py'
    file-contains src/textkit/chunking.py 'chunk_size - 1'
}

post() {
    tool-match-before-tool-match Bash 'pytest' Bash 'git[[:space:]]+commit'
}
