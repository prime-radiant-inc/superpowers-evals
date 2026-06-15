import { readFileSync, realpathSync } from 'node:fs';
import { basename, dirname, join, resolve, sep } from 'node:path';

// Per-dialect session-log cwd filtering. codex/kimi/pi store sessions under a
// shared home tree, so a parallel run's snapshot diff can surface another run's
// logs. Each filter drops logs whose recorded cwd does not match the run's
// launch cwd. Dialects without a filter (claude/codex-isolated/gemini/opencode/
// copilot/antigravity) pass through unchanged.

// Resolve symlinks so two paths to the same location compare equal (macOS hands
// out /var/folders workdirs that resolve to /private/var/...). Falls back to a
// plain resolve when the path does not exist on disk, so a recorded-but-absent
// cwd still compares.
function realPath(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return resolve(p);
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// Parse the first line of a log file as JSON, or undefined on any read/parse
// error. The cwd-bearing header is always the first line for codex/pi.
function firstLineEntry(path: string): unknown {
  let content: string;
  try {
    content = readFileSync(path, 'utf8');
  } catch {
    return undefined;
  }
  const nl = content.indexOf('\n');
  const firstLine = nl === -1 ? content : content.slice(0, nl);
  try {
    return JSON.parse(firstLine);
  } catch {
    return undefined;
  }
}

function filterCodexLogsByCwd(paths: string[], targetCwd: string): string[] {
  const target = realPath(targetCwd);
  const matched: string[] = [];
  for (const path of paths) {
    const entry = firstLineEntry(path);
    if (!isObject(entry) || entry['type'] !== 'session_meta') {
      continue;
    }
    const payload = entry['payload'];
    const cwd = isObject(payload) ? payload['cwd'] : undefined;
    if (typeof cwd === 'string' && cwd && realPath(cwd) === target) {
      matched.push(path);
    }
  }
  return matched;
}

function filterPiLogsByCwd(paths: string[], targetCwd: string): string[] {
  const target = realPath(targetCwd);
  const matched: string[] = [];
  for (const path of paths) {
    const entry = firstLineEntry(path);
    if (!isObject(entry) || entry['type'] !== 'session') {
      continue;
    }
    const cwd = entry['cwd'];
    if (typeof cwd === 'string' && cwd && realPath(cwd) === target) {
      matched.push(path);
    }
  }
  return matched;
}

// The kimi home for a wire log is the parent of the nearest ancestor dir named
// "sessions".
function kimiHomeForLog(path: string): string | undefined {
  let dir = dirname(path);
  for (;;) {
    if (basename(dir) === 'sessions') {
      return dirname(dir);
    }
    const parent = dirname(dir);
    if (parent === dir) {
      return undefined;
    }
    dir = parent;
  }
}

interface KimiIndexEntry {
  readonly sessionDir: string;
  readonly workDir: string;
}

function readKimiIndex(kimiHome: string): KimiIndexEntry[] {
  const entries: KimiIndexEntry[] = [];
  let content: string;
  try {
    content = readFileSync(join(kimiHome, 'session_index.jsonl'), 'utf8');
  } catch {
    return entries;
  }
  for (const line of content.split('\n')) {
    if (!line.trim()) {
      continue;
    }
    let entry: unknown;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (isObject(entry)) {
      entries.push({
        sessionDir: String(entry['sessionDir'] ?? ''),
        workDir: String(entry['workDir'] ?? ''),
      });
    }
  }
  return entries;
}

function filterKimiLogsByCwd(paths: string[], targetCwd: string): string[] {
  const target = realPath(targetCwd);
  const indexCache = new Map<string, KimiIndexEntry[]>();
  const matched: string[] = [];
  for (const path of paths) {
    const kimiHome = kimiHomeForLog(path);
    if (kimiHome === undefined) {
      continue;
    }
    let index = indexCache.get(kimiHome);
    if (index === undefined) {
      index = readKimiIndex(kimiHome);
      indexCache.set(kimiHome, index);
    }
    const pathReal = realPath(path);
    for (const entry of index) {
      if (!entry.sessionDir || !entry.workDir) {
        continue;
      }
      const sessionReal = realPath(entry.sessionDir);
      const inside =
        pathReal === sessionReal || pathReal.startsWith(sessionReal + sep);
      if (inside && realPath(entry.workDir) === target) {
        matched.push(path);
        break;
      }
    }
  }
  return matched;
}

const CWD_FILTERS: Readonly<
  Record<string, (paths: string[], targetCwd: string) => string[]>
> = {
  codex: filterCodexLogsByCwd,
  pi: filterPiLogsByCwd,
  kimi: filterKimiLogsByCwd,
};

// Filter new session logs to those whose recorded cwd matches targetCwd, for the
// dialects that share a home tree (codex/kimi/pi). Other dialects pass through.
export function filterLogsByCwd(
  dialect: string,
  paths: string[],
  targetCwd: string,
): string[] {
  const filter = CWD_FILTERS[dialect];
  return filter === undefined ? paths : filter(paths, targetCwd);
}
