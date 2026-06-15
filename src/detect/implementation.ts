import type { ToolCallView } from '../atif/project.ts';

/**
 * Canonicalize an argument value to a string: if value is a string, try
 * JSON.parse() and use the result; on parse failure use the raw string. If not
 * a string, use the value as-is. Then coerce to string via String().
 */
function canonicalString(value: unknown): string {
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      return String(parsed);
    } catch {
      return value;
    }
  }
  return String(value ?? '');
}

/**
 * Extract the canonical file-path from a tool call's arguments.
 * Priority order:
 *   file_path, path, TargetFile, target_file, filePath,
 *   AbsolutePath, Path, TargetPath, or "" if none present.
 */
export function toolPath(call: ToolCallView): string {
  const a = call.args;
  const raw =
    a['file_path'] ??
    a['path'] ??
    a['TargetFile'] ??
    a['target_file'] ??
    a['filePath'] ??
    a['AbsolutePath'] ??
    a['Path'] ??
    a['TargetPath'] ??
    '';
  return canonicalString(raw);
}

const WORKDIR_SEPARATOR = '/coding-agent-workdir/';

/**
 * Return the path relative to the coding-agent workdir, or "" if the path
 * is empty, absolute-but-not-under-workdir, or unavailable.
 *
 * Splits on the `/coding-agent-workdir/` segment — if that literal segment
 * appears multiple times, the portion after the LAST one is returned.
 */
export function implementationRelpath(call: ToolCallView): string {
  const p = toolPath(call);
  if (p === '') return '';

  if (p.includes(WORKDIR_SEPARATOR)) {
    const parts = p.split(WORKDIR_SEPARATOR);
    return parts[parts.length - 1] ?? '';
  }

  if (p.startsWith('/')) return '';

  return p;
}

const EXCLUDED_RE =
  /(^|\/)\.git(\/|$)|(^|\/)node_modules(\/|$)|^docs\/superpowers\/|^\.gitignore$|^\.antigravitycli(\/|$)/;

/**
 * Return true when the tool call targets an implementation file — i.e.
 * it has a non-empty workdir-relative path that is not in an excluded tree.
 */
export function isImplementationPath(call: ToolCallView): boolean {
  const rel = implementationRelpath(call);
  return rel !== '' && !EXCLUDED_RE.test(rel);
}
