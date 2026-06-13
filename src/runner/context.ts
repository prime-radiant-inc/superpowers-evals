import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { RunnerError } from './errors.ts';

// Port of quorum/runner.py:_populate_context_dir + its helpers
// (_copy_with_substitutions, _copytree_with_substitutions,
// _raise_if_context_contains_placeholders).
//
// Copies per-coding-agent HOWTOs from <codingAgentsDir>/<codingAgent>-context/
// into <runDir>/gauntlet-agent/context/, burning resolved absolute paths into
// every $… placeholder. This is the quorum workaround for tmux stripping
// arbitrary env from new sessions: the QA agent reads concrete paths from the
// substituted HOWTO/launcher rather than relying on env inheritance.

// The +x bits a shebang'd template (e.g. the launch-agent shim) keeps after
// substitution: write drops the source mode, and the QA agent invokes the shim
// by absolute path, so it must stay executable (S_IXUSR|S_IXGRP|S_IXOTH).
const EXEC_BITS = 0o111;

export interface PopulateContextDirArgs {
  readonly codingAgentsDir: string;
  readonly codingAgent: string;
  readonly runDir: string;
  readonly substitutions: Readonly<Record<string, string>>;
  // When true, a missing <codingAgent>-context/ dir is a setup error rather
  // than a silent no-op (claude must have its HOWTO + launcher).
  readonly required?: boolean;
  // Placeholders that must NOT survive substitution; any remaining one raises
  // (e.g. $CLAUDE_MODEL for the claude family).
  readonly forbiddenPlaceholders?: readonly string[];
}

export function populateContextDir(args: PopulateContextDirArgs): void {
  const {
    codingAgentsDir,
    codingAgent,
    runDir,
    substitutions,
    required = false,
    forbiddenPlaceholders = [],
  } = args;
  const src = join(codingAgentsDir, `${codingAgent}-context`);
  const dst = join(runDir, 'gauntlet-agent', 'context');
  mkdirSync(dst, { recursive: true });
  if (!existsSync(src)) {
    if (required) {
      throw new RunnerError(
        `required context directory missing: ${src}`,
        'setup',
      );
    }
    return;
  }
  for (const name of readdirSync(src)) {
    const entry = join(src, name);
    const stat = statSync(entry);
    if (stat.isFile()) {
      copyWithSubstitutions(entry, join(dst, name), substitutions);
    } else if (stat.isDirectory()) {
      copytreeWithSubstitutions(entry, join(dst, name), substitutions);
    }
  }
  if (forbiddenPlaceholders.length > 0) {
    raiseIfContextContainsPlaceholders(dst, forbiddenPlaceholders);
  }
}

// _copy_with_substitutions: read as text and apply substitutions; a binary file
// (not valid UTF-8) is copied as-is. Placeholders are applied sorted by length
// DESCENDING so a longer key (e.g. $QUORUM_AGENT_CWD_SH) is replaced before a
// prefix of it ($QUORUM_AGENT_CWD). A substituted shebang file is re-marked +x.
function copyWithSubstitutions(
  src: string,
  dst: string,
  subs: Readonly<Record<string, string>>,
): void {
  let content: string;
  try {
    content = readTextStrict(src);
  } catch {
    // Non-text fixture file (image, binary). Copy as-is.
    copyFileSync(src, dst);
    return;
  }
  const keys = Object.keys(subs).sort((a, b) => b.length - a.length);
  for (const placeholder of keys) {
    const value = subs[placeholder];
    if (value !== undefined) {
      content = content.split(placeholder).join(value);
    }
  }
  writeFileSync(dst, content);
  if (content.startsWith('#!')) {
    const mode = statSync(dst).mode;
    chmodSync(dst, mode | EXEC_BITS);
  }
}

// _copytree_with_substitutions: recurse, substituting every file.
function copytreeWithSubstitutions(
  src: string,
  dst: string,
  subs: Readonly<Record<string, string>>,
): void {
  mkdirSync(dst, { recursive: true });
  for (const name of readdirSync(src)) {
    const entry = join(src, name);
    const stat = statSync(entry);
    if (stat.isFile()) {
      copyWithSubstitutions(entry, join(dst, name), subs);
    } else if (stat.isDirectory()) {
      copytreeWithSubstitutions(entry, join(dst, name), subs);
    }
  }
}

// _raise_if_context_contains_placeholders: walk the destination tree and raise
// if any forbidden placeholder still appears in a text file. Non-text files are
// skipped (they cannot carry a substitution placeholder meaningfully).
function raiseIfContextContainsPlaceholders(
  contextDir: string,
  forbidden: readonly string[],
): void {
  for (const path of walkFiles(contextDir)) {
    let content: string;
    try {
      content = readTextStrict(path);
    } catch {
      continue;
    }
    for (const placeholder of forbidden) {
      if (content.includes(placeholder)) {
        throw new RunnerError(
          `context file contains unresolved placeholder ${placeholder}: ${path}`,
          'setup',
        );
      }
    }
  }
}

// Recursively yield every regular file under root.
function* walkFiles(root: string): Generator<string> {
  for (const name of readdirSync(root)) {
    const entry = join(root, name);
    const stat = statSync(entry);
    if (stat.isFile()) {
      yield entry;
    } else if (stat.isDirectory()) {
      yield* walkFiles(entry);
    }
  }
}

// Read a file as STRICT UTF-8, throwing on any invalid byte sequence so the
// caller falls back to a byte-identical binary copy (parity with Python's
// read_text() raising UnicodeDecodeError). A fatal TextDecoder is the faithful
// check — `buf.toString('utf8')` is lossy (it replaces bad bytes with U+FFFD),
// which would let an invalid-UTF-8 binary through and corrupt it on write-back.
function readTextStrict(path: string): string {
  return new TextDecoder('utf-8', { fatal: true }).decode(readFileSync(path));
}
