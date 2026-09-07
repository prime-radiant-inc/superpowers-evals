import type { Dirent } from 'node:fs';
import {
  copyFileSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  realpathSync,
} from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { DEPENDENCY_TREE_NAMES } from '../runner/prune.ts';

export class ConversationOutputCaptureError extends Error {}

interface RetainedFile {
  relativePath: string;
  sourcePath: string;
}

function isWithin(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..');
}

/** Snapshot readable workspace files for conversation assessment. */
export function snapshotConversationOutput(
  workdir: string,
  destination: string,
): string[] {
  let sourceRoot: string;
  try {
    if (lstatSync(workdir).isSymbolicLink()) {
      throw new Error('workspace root is a symbolic link');
    }
    sourceRoot = realpathSync(workdir);
    if (!lstatSync(sourceRoot).isDirectory()) {
      throw new Error('workspace is not a directory');
    }
  } catch (error) {
    throw new ConversationOutputCaptureError(
      `cannot read conversation workspace: ${String(error)}`,
    );
  }

  const retained: RetainedFile[] = [];
  const walk = (dir: string, displayDir: string): void => {
    let entries: Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
        a.name.localeCompare(b.name),
      );
    } catch (error) {
      throw new ConversationOutputCaptureError(
        `cannot list conversation output ${displayDir || '.'}: ${String(error)}`,
      );
    }

    for (const entry of entries) {
      if (entry.name === '.git' || DEPENDENCY_TREE_NAMES.includes(entry.name)) {
        continue;
      }
      const sourcePath = join(dir, entry.name);
      const relativePath = displayDir
        ? `${displayDir}/${entry.name}`
        : entry.name;
      if (entry.isDirectory()) {
        walk(sourcePath, relativePath);
        continue;
      }
      if (entry.isFile()) {
        retained.push({ relativePath, sourcePath });
        continue;
      }
      if (entry.isSymbolicLink()) {
        let target: string;
        try {
          target = realpathSync(sourcePath);
        } catch (error) {
          throw new ConversationOutputCaptureError(
            `cannot resolve conversation output link ${relativePath}: ${String(error)}`,
          );
        }
        if (!isWithin(sourceRoot, target)) {
          throw new ConversationOutputCaptureError(
            `conversation output link escapes workspace: ${relativePath}`,
          );
        }
        const targetParts = relative(sourceRoot, target).split(sep);
        if (
          targetParts.some(
            (part) => part === '.git' || DEPENDENCY_TREE_NAMES.includes(part),
          )
        ) {
          throw new ConversationOutputCaptureError(
            `conversation output link targets an excluded tree: ${relativePath}`,
          );
        }
        if (!lstatSync(target).isFile()) {
          throw new ConversationOutputCaptureError(
            `conversation output link is not a regular file: ${relativePath}`,
          );
        }
        retained.push({ relativePath, sourcePath: target });
        continue;
      }
      throw new ConversationOutputCaptureError(
        `conversation output contains special file: ${relativePath}`,
      );
    }
  };

  walk(sourceRoot, '');
  try {
    mkdirSync(destination, { recursive: true });
    for (const file of retained) {
      const outputPath = join(destination, ...file.relativePath.split('/'));
      mkdirSync(dirname(outputPath), { recursive: true });
      copyFileSync(file.sourcePath, outputPath);
    }
  } catch (error) {
    throw new ConversationOutputCaptureError(
      `cannot retain conversation output: ${String(error)}`,
    );
  }
  return retained.map((file) => file.relativePath);
}
