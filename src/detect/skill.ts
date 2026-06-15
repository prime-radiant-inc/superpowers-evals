import type { ToolCallView } from '../atif/project.ts';

/** Escape all regex metacharacters in a literal string for use in RegExp. */
function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Returns true when the tool call represents an agent loading skill `name`
 * whose directory segment is `dir`. Three patterns are recognized:
 *
 *   1. Native Skill tool call with matching `.args.skill`.
 *   2. Shell command (Bash / Shell / LocalShellCall) whose command/cmd
 *      contains `skills/(superpowers/)?<dir>/SKILL.md` with appropriate
 *      word-boundary characters on each side.
 *   3. Read call whose file_path/path ends with
 *      `(^|/)skills/(superpowers/)?<dir>/SKILL.md`.
 */
export function isSkillInvocation(
  call: ToolCallView,
  name: string,
  dir: string,
): boolean {
  const safeDir = escapeRegex(dir);

  // 1. Native Skill tool
  if (call.tool === 'Skill') {
    return String(call.args['skill'] ?? '') === name;
  }

  // 2. Shell tools: Bash, Shell, LocalShellCall
  if (/^(Bash|Shell|LocalShellCall)$/.test(call.tool ?? '')) {
    const cmd = String(call.args['command'] ?? call.args['cmd'] ?? '');
    // Leading boundary: start-of-string or [\s'"/]
    // Trailing boundary: end-of-string or [\s'";]
    const shellRe = new RegExp(
      `(^|[\\s'"/])skills/(superpowers/)?${safeDir}/SKILL\\.md([\\s'";]|$)`,
    );
    return shellRe.test(cmd);
  }

  // 3. Read tool
  if (call.tool === 'Read') {
    const p = String(call.args['file_path'] ?? call.args['path'] ?? '');
    const readRe = new RegExp(
      `(^|/)skills/(superpowers/)?${safeDir}/SKILL\\.md$`,
    );
    return readRe.test(p);
  }

  return false;
}
