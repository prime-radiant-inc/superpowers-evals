// src/check/manifest.ts
// Static expected-check extraction from checks.sh, and the runtime multiset
// comparison the composer enforces. The extraction rules mirror the record
// emission pinned by test/check-manifest.test.ts's characterization block:
//   - plain fs verb -> record name is the verb, args are its literal args;
//   - `not <fs-verb>` -> record name is the inner verb, negated=true;
//   - plain `check-transcript <verb>` -> record name is the inner VERB;
//   - `not check-transcript <verb>` -> record name is the WRAPPER
//     `check-transcript`, negated=true, args = [verb, ...verb-args].
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  type CheckManifest,
  CheckManifestSchema,
  type ManifestEntry,
} from '../contracts/check-manifest.ts';
import type { CheckPhase, CheckRecord } from '../contracts/verdict.ts';
import { FS_VERBS } from './dispatch.ts';
import { TRANSCRIPT_VERBS } from './transcript-dispatch.ts';

export class ManifestExtractionError extends Error {}

export function manifestPath(scenarioDir: string): string {
  return join(scenarioDir, 'checks-manifest.json');
}

const FS_VERB_NAMES = new Set(Object.keys(FS_VERBS));
const TRANSCRIPT_VERB_NAMES = new Set(TRANSCRIPT_VERBS);

// Minimal bash tokenizer for functions-only checks.sh bodies: handles
// whitespace splitting, single quotes (no expansion), double quotes, and
// backslash escapes. Anything fancier (pipes, subshells at top level) is a
// scaffold lint violation before it ever reaches us.
function tokenize(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let started = false;
  let i = 0;
  while (i < line.length) {
    const c = line[i] as string;
    if (c === "'") {
      started = true;
      const end = line.indexOf("'", i + 1);
      if (end === -1)
        throw new ManifestExtractionError(`unterminated quote: ${line}`);
      cur += line.slice(i + 1, end);
      i = end + 1;
    } else if (c === '"') {
      started = true;
      i += 1;
      while (i < line.length && line[i] !== '"') {
        if (line[i] === '\\' && i + 1 < line.length) {
          cur += line[i + 1] as string;
          i += 2;
        } else {
          cur += line[i] as string;
          i += 1;
        }
      }
      if (line[i] !== '"')
        throw new ManifestExtractionError(`unterminated quote: ${line}`);
      i += 1;
    } else if (c === '\\' && i + 1 < line.length) {
      started = true;
      cur += line[i + 1] as string;
      i += 2;
    } else if (/\s/.test(c)) {
      if (started || cur) {
        out.push(cur);
        cur = '';
        started = false;
      }
      i += 1;
    } else {
      started = true;
      cur += c;
      i += 1;
    }
  }
  if (started || cur) out.push(cur);
  return out;
}

interface RawLine {
  phase: CheckPhase;
  tokens: string[];
  rawArgsHaveDollar: boolean;
}

function functionBodies(text: string): RawLine[] {
  const lines: RawLine[] = [];
  let phase: CheckPhase | null = null;
  let depth = 0;
  for (const raw of text.split(/\r?\n/)) {
    const s = raw.trim();
    if (!s || s.startsWith('#')) continue;
    const decl = /^(pre|post)\s*\(\)/.exec(s);
    if (decl) {
      phase = decl[1] as CheckPhase;
      depth += (s.match(/{/g) ?? []).length - (s.match(/}/g) ?? []).length;
      continue;
    }
    if (s === '{') {
      depth += 1;
      continue;
    }
    if (s === '}') {
      depth -= 1;
      if (depth <= 0) phase = null;
      continue;
    }
    if (phase && depth > 0) {
      lines.push({
        phase,
        tokens: tokenize(s),
        rawArgsHaveDollar: s.includes('$'),
      });
    }
  }
  return lines;
}

function toEntryKeyParts(tokens: string[]): {
  check: string;
  args: string[];
  negated: boolean;
} {
  let negated = false;
  let rest = tokens;
  if (rest[0] === 'not') {
    negated = true;
    rest = rest.slice(1);
  }
  const head = rest[0];
  if (head === undefined) throw new ManifestExtractionError('empty check line');
  if (head === 'setup-helpers') {
    throw new ManifestExtractionError(
      'setup-helpers is a setup.sh function, not a check',
    );
  }
  if (head === 'check-transcript') {
    const verb = rest[1];
    if (verb === undefined || !TRANSCRIPT_VERB_NAMES.has(verb)) {
      throw new ManifestExtractionError(
        `unknown transcript verb: ${verb ?? '(none)'}`,
      );
    }
    // Emission rule (Task 1 characterization): plain -> inner verb name;
    // negated -> wrapper name with the full wrapped argv as args.
    return negated
      ? { check: 'check-transcript', args: rest.slice(1), negated: true }
      : { check: verb, args: rest.slice(2), negated: false };
  }
  if (!FS_VERB_NAMES.has(head)) {
    throw new ManifestExtractionError(`unknown check verb: ${head}`);
  }
  return { check: head, args: rest.slice(1), negated };
}

export function extractManifest(checksShPath: string): CheckManifest {
  const text = readFileSync(checksShPath, 'utf8');
  const counted = new Map<string, ManifestEntry>();
  for (const line of functionBodies(text)) {
    const { check, args, negated } = toEntryKeyParts(line.tokens);
    const wild = line.rawArgsHaveDollar;
    const entryArgs = wild ? null : args;
    const key = JSON.stringify([line.phase, check, negated, entryArgs]);
    const prev = counted.get(key);
    if (prev) prev.count += 1;
    else
      counted.set(key, {
        phase: line.phase,
        check,
        args: entryArgs,
        negated,
        count: 1,
      });
  }
  return { schema_version: 1, entries: [...counted.values()] };
}

export function readManifest(scenarioDir: string): CheckManifest | null {
  const p = manifestPath(scenarioDir);
  if (!existsSync(p)) return null;
  return CheckManifestSchema.parse(JSON.parse(readFileSync(p, 'utf8')));
}

export function writeManifest(scenarioDir: string, m: CheckManifest): void {
  writeFileSync(manifestPath(scenarioDir), `${JSON.stringify(m, null, 2)}\n`);
}

function recordKey(r: CheckRecord): string {
  return JSON.stringify([r.phase, r.check, r.negated, r.args]);
}

export function compareRecords(
  expected: CheckManifest,
  records: readonly CheckRecord[],
): { missing: string[]; unexpected: string[] } {
  const remaining = [...records];
  const missing: string[] = [];
  const take = (pred: (r: CheckRecord) => boolean): boolean => {
    const i = remaining.findIndex(pred);
    if (i === -1) return false;
    remaining.splice(i, 1);
    return true;
  };
  // Exact-args entries consume first so wildcards can't steal their records.
  const [exact, wild] = [
    expected.entries.filter((e) => e.args !== null),
    expected.entries.filter((e) => e.args === null),
  ];
  for (const e of exact) {
    for (let k = 0; k < e.count; k++) {
      const key = JSON.stringify([e.phase, e.check, e.negated, e.args]);
      if (!take((r) => recordKey(r) === key)) {
        missing.push(
          `${e.phase}:${e.negated ? 'not ' : ''}${e.check} ${e.args?.join(' ') ?? ''}`.trim(),
        );
      }
    }
  }
  for (const e of wild) {
    for (let k = 0; k < e.count; k++) {
      if (
        !take(
          (r) =>
            r.phase === e.phase &&
            r.check === e.check &&
            r.negated === e.negated,
        )
      ) {
        missing.push(
          `${e.phase}:${e.negated ? 'not ' : ''}${e.check} <wildcard>`,
        );
      }
    }
  }
  const unexpected = remaining.map((r) =>
    `${r.phase}:${r.negated ? 'not ' : ''}${r.check} ${r.args.join(' ')}`.trim(),
  );
  return { missing, unexpected };
}
