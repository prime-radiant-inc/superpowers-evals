pre() {
    git-repo
    git-branch main
    requires-tool npm
    file-exists 'docs/superpowers/plans/report-plan.md'
    file-contains 'docs/superpowers/plans/report-plan.md' 'repeat\(40\)'
    file-contains 'docs/superpowers/plans/report-plan.md' 'repeat\(30\)'
}

post() {
    check-transcript skill-called superpowers:subagent-driven-development
    check-transcript tool-called Agent
    command-succeeds 'npm test'
    file-contains 'src/report.js' 'export function formatUserReport'
    file-contains 'src/report.js' 'export function formatAdminReport'
    # Behavioral banner check: render the two functions the plan mandates
    # and measure the banner lines in their OUTPUT — every all-'=' line
    # must be exactly 40 chars (the Global Constraints side of the planted
    # 40-vs-30 contradiction), so a 30-char banner shipping anywhere in
    # either report fails. Replaces literal greps for "repeat(40)"/
    # "repeat(30)" in the source, which false-failed behaviorally-correct
    # runs that spelled the width as a named constant (const BANNER_WIDTH
    # = 40; 3/10 runs on 08-06). Measuring rendered output is indifferent
    # to how the source spells the number.
    command-succeeds 'node --input-type=module -e "import assert from \"node:assert/strict\"; const m = await import(\"./src/report.js\"); const reports = [[\"formatUserReport\", m.formatUserReport({ name: \"Ada\", email: \"ada@example.com\", visits: 3 })], [\"formatAdminReport\", m.formatAdminReport({ name: \"Grace\", email: \"grace@example.com\", lastLogin: \"2026-06-01\" })]]; for (const [name, out] of reports) { const banners = String(out).split(/\r?\n/).filter((l) => /^=+$/.test(l)); assert.ok(banners.length > 0, name + \": no banner line rendered\"); for (const b of banners) assert.equal(b.length, 40, name + \" rendered a \" + b.length + \"-char banner\"); }"'
}
