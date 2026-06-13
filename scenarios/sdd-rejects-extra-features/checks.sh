pre() {
    git-repo
    git-branch main
    requires-tool npm
    file-exists 'docs/superpowers/plans/math-plan.md'
    file-contains 'docs/superpowers/plans/math-plan.md' 'DO NOT add any extra features'
}

post() {
    check-transcript skill-called superpowers:subagent-driven-development
    check-transcript tool-called Agent
    command-succeeds 'npm test'
    file-contains 'src/math.js' 'export function add'
    file-contains 'src/math.js' 'export function multiply'
    not file-contains 'src/math.js' 'export function divide'
    not file-contains 'src/math.js' 'export function power'
    not file-contains 'src/math.js' 'export function subtract'
}
