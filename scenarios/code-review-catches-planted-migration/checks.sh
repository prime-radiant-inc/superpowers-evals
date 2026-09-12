#!/usr/bin/env bash

pre() {
    git-repo
    git-branch main
    git-count commits eq 2
    file-exists 'migrations/002_split_name.sql'
    file-contains 'migrations/002_split_name.sql' 'DROP COLUMN full_name'
    file-contains 'src/db.js' 'first_name, last_name'
}

post() {
    check-transcript skill-called superpowers:requesting-code-review
    check-transcript tool-called Agent
}
