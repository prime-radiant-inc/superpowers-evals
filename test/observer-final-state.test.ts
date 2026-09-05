import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import {
  appendFileSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as credentialScope from '../src/appliance/credential-scope.ts';
import {
  captureFinalState,
  type FinalState,
  FinalStateError,
  type FinalStateRoot,
  verifyFinalState,
} from '../src/experiments/observer/final-state.ts';

const fixtureDirs: string[] = [];

function fixture(): { base: string; roots: FinalStateRoot[] } {
  const created = mkdtempSync(join(tmpdir(), 'quorum-final-state-'));
  const base = realpathSync(created);
  fixtureDirs.push(base);
  mkdirSync(join(base, 'logs'));
  mkdirSync(join(base, 'workdir'));
  writeFileSync(join(base, 'logs', 'parent.jsonl'), '{"type":"fixture"}\n');
  writeFileSync(join(base, 'workdir', 'design.md'), 'Draft\n');
  return {
    base,
    roots: [
      { id: 'logs', kind: 'transcripts', path: join(base, 'logs') },
      { id: 'workdir', kind: 'artifacts', path: join(base, 'workdir') },
    ],
  };
}

afterEach(() => {
  for (const path of fixtureDirs.splice(0)) {
    rmSync(path, { recursive: true, force: true });
  }
});

interface SnapshotNode {
  path: string;
  kind: 'directory' | 'file' | 'symlink' | 'special';
  device: string;
  inode: string;
  bytes?: string;
  target?: string;
}

function snapshotTree(root: string): SnapshotNode[] {
  const nodes: SnapshotNode[] = [];
  const visit = (absolutePath: string, relativePath: string): void => {
    const stats = lstatSync(absolutePath, { bigint: true });
    const identity = {
      path: relativePath,
      device: stats.dev.toString(10),
      inode: stats.ino.toString(10),
    };
    if (stats.isSymbolicLink()) {
      nodes.push({
        ...identity,
        kind: 'symlink',
        target: readlinkSync(absolutePath),
      });
      return;
    }
    if (stats.isDirectory()) {
      nodes.push({ ...identity, kind: 'directory' });
      for (const name of readdirSync(absolutePath).sort()) {
        visit(
          join(absolutePath, name),
          relativePath ? `${relativePath}/${name}` : name,
        );
      }
      return;
    }
    if (stats.isFile()) {
      nodes.push({
        ...identity,
        kind: 'file',
        bytes: readFileSync(absolutePath).toString('base64'),
      });
      return;
    }
    nodes.push({ ...identity, kind: 'special' });
  };
  visit(root, '');
  return nodes;
}

function expectFinalStateError(
  action: () => void,
  code: FinalStateError['code'],
): void {
  let caught: unknown;
  try {
    action();
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(FinalStateError);
  expect((caught as FinalStateError).code).toBe(code);
}

function expectVerificationErrorPreserves(
  base: string,
  roots: readonly FinalStateRoot[],
  candidate: FinalState,
  code: FinalStateError['code'],
): void {
  const originalCandidate = structuredClone(candidate);
  const changedSource = snapshotTree(base);
  expectFinalStateError(() => verifyFinalState(roots, candidate), code);
  expect(candidate).toEqual(originalCandidate);
  expect(snapshotTree(base)).toEqual(changedSource);
}

describe('observer final-state inventory', () => {
  test('captures complete source bytes and verifies an unchanged inventory', () => {
    const { base, roots } = fixture();
    const originalSource = snapshotTree(base);

    const candidate = captureFinalState(roots);

    expect(candidate.schema_version).toBe(2);
    expect(candidate.roots).toEqual([
      { id: 'logs', kind: 'transcripts' },
      { id: 'workdir', kind: 'artifacts' },
    ]);
    expect(
      candidate.nodes.map(({ root_id, path, kind, bytes, sha256 }) => ({
        root_id,
        path,
        kind,
        bytes,
        sha256,
      })),
    ).toEqual([
      {
        root_id: 'logs',
        path: '',
        kind: 'directory',
        bytes: null,
        sha256: null,
      },
      {
        root_id: 'logs',
        path: 'parent.jsonl',
        kind: 'file',
        bytes: 19,
        sha256:
          '2b9b8e8c7748cfc6cb39a84aa6c514dffe95258f9b7d729818dcd85005f048fd',
      },
      {
        root_id: 'workdir',
        path: '',
        kind: 'directory',
        bytes: null,
        sha256: null,
      },
      {
        root_id: 'workdir',
        path: 'design.md',
        kind: 'file',
        bytes: 6,
        sha256:
          '2cbfaf4c20c7513d1df2526f07cd40d1a473289ed319b7b9eec5074a7f01b60c',
      },
    ]);
    expect(snapshotTree(base)).toEqual(originalSource);
    expect(() => verifyFinalState(roots, candidate)).not.toThrow();
    expect(snapshotTree(base)).toEqual(originalSource);
  });

  test('rejects a transcript append after candidate capture without changing evidence', () => {
    const { base, roots } = fixture();
    const candidate = captureFinalState(roots);
    const originalCandidate = structuredClone(candidate);
    const logPath = join(base, 'logs', 'parent.jsonl');
    appendFileSync(logPath, '{"late":true}\n');
    const changedBytes = readFileSync(logPath);

    try {
      verifyFinalState(roots, candidate);
      throw new Error('accepted stale evidence');
    } catch (error) {
      expect(error).toBeInstanceOf(FinalStateError);
      expect((error as FinalStateError).code).toBe('final_state_mismatch');
    }
    expect(candidate).toEqual(originalCandidate);
    expect(readFileSync(logPath)).toEqual(changedBytes);
  });

  const mismatchCases: readonly {
    name: string;
    prepare?: (base: string) => void;
    mutate: (base: string) => void;
  }[] = [
    {
      name: 'same-size transcript rewrite',
      mutate: (base) =>
        writeFileSync(
          join(base, 'logs', 'parent.jsonl'),
          '{"type":"altered"}\n',
        ),
    },
    {
      name: 'raw-log addition',
      mutate: (base) =>
        writeFileSync(join(base, 'logs', 'child.jsonl'), '{}\n'),
    },
    {
      name: 'raw-log deletion',
      mutate: (base) => rmSync(join(base, 'logs', 'parent.jsonl')),
    },
    {
      name: 'new nested descendant log',
      mutate: (base) => {
        mkdirSync(join(base, 'logs', 'descendant'));
        writeFileSync(join(base, 'logs', 'descendant', 'child.jsonl'), '{}\n');
      },
    },
    {
      name: 'document addition',
      mutate: (base) =>
        writeFileSync(join(base, 'workdir', 'notes.md'), 'Notes\n'),
    },
    {
      name: 'document deletion',
      mutate: (base) => rmSync(join(base, 'workdir', 'design.md')),
    },
    {
      name: 'non-Markdown artifact change',
      prepare: (base) =>
        writeFileSync(
          join(base, 'workdir', 'result.bin'),
          new Uint8Array([1, 2, 3]),
        ),
      mutate: (base) =>
        writeFileSync(
          join(base, 'workdir', 'result.bin'),
          new Uint8Array([3, 2, 1]),
        ),
    },
    {
      name: 'nested directory deletion',
      prepare: (base) => mkdirSync(join(base, 'workdir', 'empty')),
      mutate: (base) =>
        rmSync(join(base, 'workdir', 'empty'), { recursive: true }),
    },
  ];

  for (const mismatchCase of mismatchCases) {
    test(`rejects ${mismatchCase.name} without changing candidate or source`, () => {
      const { base, roots } = fixture();
      mismatchCase.prepare?.(base);
      const candidate = captureFinalState(roots);
      mismatchCase.mutate(base);

      expectVerificationErrorPreserves(
        base,
        roots,
        candidate,
        'final_state_mismatch',
      );
    });
  }

  test('rejects identical replacement bytes from a different inode', () => {
    const { base, roots } = fixture();
    const target = join(base, 'workdir', 'design.md');
    const candidate = captureFinalState(roots);
    const originalInode = lstatSync(target, { bigint: true }).ino;
    const replacement = join(base, 'workdir', 'replacement');
    writeFileSync(replacement, 'Draft\n');
    renameSync(replacement, target);
    expect(lstatSync(target, { bigint: true }).ino).not.toBe(originalInode);

    expectVerificationErrorPreserves(
      base,
      roots,
      candidate,
      'final_state_mismatch',
    );
  });

  test('preserves nested and empty directories and exact UTF-8 CRLF bytes', () => {
    const { base, roots } = fixture();
    mkdirSync(join(base, 'logs', 'nested', 'empty'), { recursive: true });
    writeFileSync(join(base, 'logs', 'nested', 'utf8.jsonl'), 'utf8: café\r\n');
    mkdirSync(join(base, 'workdir', 'empty'));
    const originalSource = snapshotTree(base);

    const candidate = captureFinalState(roots);

    expect(
      candidate.nodes.map(({ root_id, path, kind }) => ({
        root_id,
        path,
        kind,
      })),
    ).toContainEqual({
      root_id: 'logs',
      path: 'nested/empty',
      kind: 'directory',
    });
    expect(candidate.nodes).toContainEqual({
      root_id: 'logs',
      path: 'nested/utf8.jsonl',
      kind: 'file',
      device: expect.any(String),
      inode: expect.any(String),
      bytes: 13,
      sha256:
        'aefab1422e73e73b062a619a3dbf6181fdfc859b765038e24a94b0c12a720c75',
    });
    expect(candidate.nodes).toContainEqual({
      root_id: 'workdir',
      path: 'empty',
      kind: 'directory',
      device: expect.any(String),
      inode: expect.any(String),
      bytes: null,
      sha256: null,
    });
    verifyFinalState(roots, candidate);
    expect(snapshotTree(base)).toEqual(originalSource);
  });

  test('canonicalizes root ordering before capture and verification', () => {
    const { roots } = fixture();
    const forward = captureFinalState(roots);
    const reversed = captureFinalState([...roots].reverse());
    const reorderedCandidate: FinalState = {
      ...structuredClone(forward),
      roots: [...forward.roots].reverse(),
      nodes: [...forward.nodes].reverse(),
    };
    const originalCandidate = structuredClone(reorderedCandidate);

    expect(reversed).toEqual(forward);
    expect(() => verifyFinalState([...roots].reverse(), forward)).not.toThrow();
    expect(() => verifyFinalState(roots, reorderedCandidate)).not.toThrow();
    expect(reorderedCandidate).toEqual(originalCandidate);
  });

  test('orders root IDs and relative paths by lexical code units', () => {
    const { base, roots } = fixture();
    writeFileSync(join(base, 'logs', 'Z.jsonl'), '{}\n');
    writeFileSync(join(base, 'logs', 'a.jsonl'), '{}\n');
    writeFileSync(join(base, 'logs', 'ä.jsonl'), '{}\n');
    const reorderedRoots = [
      { ...roots[0]!, id: 'z-logs' },
      { ...roots[1]!, id: 'A-workdir' },
    ];

    const candidate = captureFinalState(reorderedRoots);

    expect(candidate.roots.map(({ id }) => id)).toEqual([
      'A-workdir',
      'z-logs',
    ]);
    expect(
      candidate.nodes
        .filter(({ root_id }) => root_id === 'z-logs')
        .map(({ path }) => path),
    ).toEqual(['', 'Z.jsonl', 'a.jsonl', 'parent.jsonl', 'ä.jsonl']);
  });

  test('ignores excluded artifact trees and regular non-jsonl transcript files', () => {
    const { base, roots } = fixture();
    mkdirSync(join(base, 'workdir', '.git'));
    mkdirSync(join(base, 'workdir', 'node_modules'));
    writeFileSync(join(base, 'workdir', '.git', 'index'), 'ignored');
    writeFileSync(join(base, 'workdir', 'node_modules', 'package'), 'ignored');
    writeFileSync(join(base, 'logs', 'note.txt'), 'ignored');

    const candidate = captureFinalState(roots);

    expect(candidate.nodes.some(({ path }) => path.includes('.git'))).toBe(
      false,
    );
    expect(
      candidate.nodes.some(({ path }) => path.includes('node_modules')),
    ).toBe(false);
    expect(candidate.nodes.some(({ path }) => path === 'note.txt')).toBe(false);
    expect(() => verifyFinalState(roots, candidate)).not.toThrow();
  });

  test('rejects a missing source root without changing the remaining source', () => {
    const { base, roots } = fixture();
    rmSync(join(base, 'logs'), { recursive: true });
    const source = snapshotTree(base);

    expectFinalStateError(() => captureFinalState(roots), 'source_unavailable');
    expect(snapshotTree(base)).toEqual(source);
  });

  test('rejects an actual root-directory substitution after the root is pinned', () => {
    const { base, roots } = fixture();
    const logsRoot = roots[0]!.path;
    const originalLogs = join(base, 'original-logs');
    const replacementLogs = join(base, 'replacement-logs');
    mkdirSync(replacementLogs);
    const realPin = credentialScope.pinAbsoluteDir.bind(credentialScope);
    let substituted = false;
    const pinSpy = spyOn(credentialScope, 'pinAbsoluteDir').mockImplementation(
      (path, label) => {
        const pin = realPin(path, label);
        if (!substituted && path === logsRoot) {
          renameSync(logsRoot, originalLogs);
          renameSync(replacementLogs, logsRoot);
          substituted = true;
        }
        return pin;
      },
    );

    try {
      expectFinalStateError(() => captureFinalState(roots), 'source_changed');
      expect(substituted).toBe(true);
    } finally {
      pinSpy.mockRestore();
    }
  });

  test('rejects an actual root-ancestor substitution after the root is pinned', () => {
    const { base, roots } = fixture();
    const sourceParent = join(base, 'source-parent');
    const originalParent = join(base, 'original-parent');
    const replacementParent = join(base, 'replacement-parent');
    mkdirSync(join(sourceParent, 'logs'), { recursive: true });
    mkdirSync(join(replacementParent, 'logs'), { recursive: true });
    const logsRoot = join(sourceParent, 'logs');
    const changedRoots: FinalStateRoot[] = [
      { id: 'logs', kind: 'transcripts', path: logsRoot },
      roots[1]!,
    ];
    const realPin = credentialScope.pinAbsoluteDir.bind(credentialScope);
    let substituted = false;
    const pinSpy = spyOn(credentialScope, 'pinAbsoluteDir').mockImplementation(
      (path, label) => {
        const pin = realPin(path, label);
        if (!substituted && path === logsRoot) {
          renameSync(sourceParent, originalParent);
          renameSync(replacementParent, sourceParent);
          substituted = true;
        }
        return pin;
      },
    );

    try {
      expectFinalStateError(
        () => captureFinalState(changedRoots),
        'source_changed',
      );
      expect(substituted).toBe(true);
    } finally {
      pinSpy.mockRestore();
    }
  });

  const symlinkCases: readonly {
    name: string;
    mutate: (base: string, roots: FinalStateRoot[]) => FinalStateRoot[];
  }[] = [
    {
      name: 'root',
      mutate: (base, roots) => {
        const realLogs = join(base, 'real-logs');
        mkdirSync(realLogs);
        symlinkSync(realLogs, join(base, 'logs-link'));
        return [
          { id: 'logs', kind: 'transcripts', path: join(base, 'logs-link') },
          roots[1]!,
        ];
      },
    },
    {
      name: 'root ancestor',
      mutate: (base, roots) => {
        const realParent = join(base, 'real-parent');
        mkdirSync(join(realParent, 'logs'), { recursive: true });
        symlinkSync(realParent, join(base, 'alias-parent'));
        return [
          {
            id: 'logs',
            kind: 'transcripts',
            path: join(base, 'alias-parent', 'logs'),
          },
          roots[1]!,
        ];
      },
    },
    {
      name: 'file',
      mutate: (base, roots) => {
        symlinkSync(
          join(base, 'logs', 'parent.jsonl'),
          join(base, 'logs', 'linked.jsonl'),
        );
        return roots;
      },
    },
    {
      name: 'subdirectory',
      mutate: (base, roots) => {
        symlinkSync(join(base, 'workdir'), join(base, 'logs', 'linked-dir'));
        return roots;
      },
    },
  ];

  for (const symlinkCase of symlinkCases) {
    test(`rejects a symlinked ${symlinkCase.name} without reading target bytes`, () => {
      const { base, roots } = fixture();
      const changedRoots = symlinkCase.mutate(base, roots);
      const source = snapshotTree(base);

      expectFinalStateError(
        () => captureFinalState(changedRoots),
        'source_unavailable',
      );
      expect(snapshotTree(base)).toEqual(source);
    });
  }

  test('rejects non-regular entries before transcript extension filtering', () => {
    const { base, roots } = fixture();
    const fifo = join(base, 'logs', 'unrelated.tmp');
    const created = spawnSync('mkfifo', [fifo]);
    expect(created.status).toBe(0);
    const source = snapshotTree(base);

    expectFinalStateError(() => captureFinalState(roots), 'source_unavailable');
    expect(snapshotTree(base)).toEqual(source);
  });

  test('maps a static child EACCES to source_unavailable during traversal', () => {
    const { base, roots } = fixture();
    const blockedPath = join(base, 'logs', 'blocked.jsonl');
    writeFileSync(blockedPath, '{}\n');
    const realLstat = fs.lstatSync.bind(fs);
    const statSpy = spyOn(fs, 'lstatSync').mockImplementation(((
      path: fs.PathLike,
      options: { bigint: true },
    ) => {
      if (
        path === blockedPath ||
        (typeof path === 'string' && path.endsWith('/blocked.jsonl'))
      ) {
        throw Object.assign(new Error('permission denied'), {
          code: 'EACCES',
        });
      }
      return realLstat(path, options);
    }) as typeof fs.lstatSync);

    try {
      expectFinalStateError(
        () => captureFinalState(roots),
        'source_unavailable',
      );
    } finally {
      statSpy.mockRestore();
    }
  });

  test('maps a disappearing child ENOENT to source_changed during traversal', () => {
    const { base, roots } = fixture();
    const missingPath = join(base, 'logs', 'missing.jsonl');
    writeFileSync(missingPath, '{}\n');
    const realLstat = fs.lstatSync.bind(fs);
    const statSpy = spyOn(fs, 'lstatSync').mockImplementation(((
      path: fs.PathLike,
      options: { bigint: true },
    ) => {
      if (
        path === missingPath ||
        (typeof path === 'string' && path.endsWith('/missing.jsonl'))
      ) {
        throw Object.assign(new Error('missing'), { code: 'ENOENT' });
      }
      return realLstat(path, options);
    }) as typeof fs.lstatSync);

    try {
      expectFinalStateError(() => captureFinalState(roots), 'source_changed');
    } finally {
      statSpy.mockRestore();
    }
  });

  test.skipIf(process.platform === 'win32')(
    'maps source names that cannot be represented in a candidate to source_unavailable',
    () => {
      const { base, roots } = fixture();
      writeFileSync(join(base, 'logs', 'C:drive.jsonl'), '{}\n');
      writeFileSync(join(base, 'logs', 'back\\slash.jsonl'), '{}\n');

      expectFinalStateError(
        () => captureFinalState(roots),
        'source_unavailable',
      );
    },
  );

  test('rejects malformed, incomplete, and duplicate candidate inventories', () => {
    const { base, roots } = fixture();
    const candidate = captureFinalState(roots);
    const designNode = candidate.nodes.find(
      ({ root_id, path }) => root_id === 'workdir' && path === 'design.md',
    )!;
    const invalidCandidates: FinalState[] = [
      { ...candidate, schema_version: 1 } as unknown as FinalState,
      { ...candidate, unexpected: true } as unknown as FinalState,
      {
        ...candidate,
        roots: candidate.roots.map((root, index) =>
          index === 0 ? { ...root, path: '/candidate-selected' } : root,
        ),
      } as unknown as FinalState,
      {
        ...candidate,
        nodes: candidate.nodes.map((node) =>
          node === designNode ? { ...node, path: '../design.md' } : node,
        ),
      },
      {
        ...candidate,
        nodes: [...candidate.nodes, structuredClone(designNode)],
      },
      {
        ...candidate,
        nodes: candidate.nodes.map((node) =>
          node.path === '' && node.root_id === 'logs'
            ? { ...node, bytes: 0 }
            : node,
        ),
      } as unknown as FinalState,
      {
        ...candidate,
        nodes: candidate.nodes.map((node) =>
          node === designNode ? { ...node, device: -1 } : node,
        ),
      } as unknown as FinalState,
      {
        ...candidate,
        nodes: candidate.nodes.map((node) =>
          node === designNode ? { ...node, bytes: null, sha256: null } : node,
        ),
      } as unknown as FinalState,
      {
        ...candidate,
        nodes: candidate.nodes.map((node) =>
          node === designNode
            ? { ...node, sha256: node.sha256?.toUpperCase() ?? null }
            : node,
        ),
      },
      {
        ...candidate,
        nodes: candidate.nodes.map((node) =>
          node === designNode ? { ...node, unexpected: true } : node,
        ),
      } as unknown as FinalState,
      {
        ...candidate,
        nodes: candidate.nodes.filter(
          ({ root_id, path }) => !(root_id === 'logs' && path === ''),
        ),
      },
      {
        ...candidate,
        roots: candidate.roots.filter(({ id }) => id !== 'workdir'),
      },
    ];

    for (const invalid of invalidCandidates) {
      expectVerificationErrorPreserves(base, roots, invalid, 'invalid_state');
    }
  });

  test('rejects every unsafe candidate path form', () => {
    const { base, roots } = fixture();
    const candidate = captureFinalState(roots);
    for (const path of [
      '/absolute',
      'C:drive',
      'C:/drive',
      '',
      'nested\\file',
      'nested//file',
      './file',
      'nested/../file',
      'nul\0file',
    ]) {
      const invalid = {
        ...candidate,
        nodes: candidate.nodes.map((node) =>
          node.kind === 'file' && node.root_id === 'logs'
            ? { ...node, path }
            : node,
        ),
      };
      expectVerificationErrorPreserves(base, roots, invalid, 'invalid_state');
    }
  });

  test('treats an omitted non-root node as a mismatch', () => {
    const { base, roots } = fixture();
    const candidate = captureFinalState(roots);
    candidate.nodes = candidate.nodes.filter(
      ({ root_id, path }) => !(root_id === 'workdir' && path === 'design.md'),
    );

    expectVerificationErrorPreserves(
      base,
      roots,
      candidate,
      'final_state_mismatch',
    );
  });

  test('rejects caller-mismatched candidates before reading caller roots', () => {
    const { base, roots } = fixture();
    const candidate = captureFinalState(roots);
    candidate.roots = candidate.roots.map((root) => ({
      ...root,
      kind: root.kind === 'artifacts' ? 'transcripts' : 'artifacts',
    }));
    const unavailableRoots = roots.map((root) => ({
      ...root,
      path: join(base, 'does-not-exist', root.id),
    }));

    expectVerificationErrorPreserves(
      base,
      unavailableRoots,
      candidate,
      'invalid_state',
    );
  });

  test('validates caller roots completely before source traversal', () => {
    const { base, roots } = fixture();
    const invalidRootSets: FinalStateRoot[][] = [
      [roots[0]!],
      [roots[1]!],
      [roots[0]!, { ...roots[1]!, id: roots[0]!.id }],
      [{ ...roots[0]!, path: 'relative/logs' }, roots[1]!],
      [
        { ...roots[0]!, unexpected: true } as unknown as FinalStateRoot,
        roots[1]!,
      ],
    ];
    const source = snapshotTree(base);

    for (const invalidRoots of invalidRootSets) {
      expectFinalStateError(
        () => captureFinalState(invalidRoots),
        'invalid_state',
      );
    }
    expect(snapshotTree(base)).toEqual(source);
  });

  test('rejects a child-process append completed after candidate capture', () => {
    const { base, roots } = fixture();
    const candidate = captureFinalState(roots);
    const logPath = join(base, 'logs', 'parent.jsonl');
    const child = spawnSync(process.execPath, [
      '-e',
      "import { appendFileSync } from 'node:fs'; appendFileSync(process.argv[1], '{\"late_child\":true}\\n');",
      logPath,
    ]);
    expect(child.status).toBe(0);

    expectVerificationErrorPreserves(
      base,
      roots,
      candidate,
      'final_state_mismatch',
    );
  });
});
