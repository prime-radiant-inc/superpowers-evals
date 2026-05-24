# harness/bin/_skill_predicate.jq
# Shared jq predicate: did this trace event invoke a superpowers Skill?
#
# Sourced via jq's -L include mechanism by the four skill-* tools
# (skill-called, skill-not-called, skill-before-tool,
# skill-before-tool-match) so all of them recognize the same set of
# invocation patterns. Before this file existed, skill-called and
# skill-not-called counted both native Skill calls AND shell reads of
# SKILL.md, but the ordering tools (skill-before-tool*) only counted
# the native form — so a Codex-driven run that loaded a skill via Bash
# would pass `skill-called X` and FAIL `skill-before-tool X Y` against
# the same trace. (Codex review feedback P2, 2026-05-24.)
#
# Coverage:
#   1. Native Skill tool calls: .tool == "Skill" with matching .args.skill.
#   2. Shell-read SKILL.md (Codex / portable pattern): the agent invokes
#      Bash / Shell / LocalShellCall with a command containing
#      "skills/<superpowers/>?<dir>/SKILL.md", optionally bounded by
#      whitespace, slashes, or quote characters.
#
# Arguments:
#   $name → full colon-prefixed skill name (e.g. "superpowers:brainstorming")
#   $dir  → trailing segment (e.g. "brainstorming") — what appears in the
#           SKILL.md path, distinct from $name because the colon-prefixed
#           form doesn't appear in shell paths.
#
# Use via `jq -L "$(dirname "$0")" 'include "_skill_predicate"; …'`.
def is_skill_invocation($name; $dir):
    (.tool == "Skill" and (.args.skill // "") == $name)
    or (
        ((.tool // "") | test("^(Bash|Shell|LocalShellCall)$"))
        and (
            ((.args.command // .args.cmd // "") | test(
                "(^|[[:space:]'\\''\"/])skills/(superpowers/)?" + $dir + "/SKILL[.]md([[:space:]'\\''\";]|$)"
            ))
        )
    );
