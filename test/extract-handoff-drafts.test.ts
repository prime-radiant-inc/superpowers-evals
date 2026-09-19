import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { extractHandoffDrafts } from '../scripts/extract-handoff-drafts.ts';

describe('extractHandoffDrafts', () => {
  test('freezes the first added spec and blinds it against the final artifact', () => {
    const root = mkdtempSync(join(tmpdir(), 'handoff-drafts-'));
    const workdir = join(root, 'coding-agent-workdir');
    const spec = 'docs/superpowers/specs/example.md';
    mkdirSync(join(workdir, 'docs/superpowers/specs'), { recursive: true });
    mkdirSync(join(workdir, 'src'), { recursive: true });
    mkdirSync(join(workdir, '.git'), { recursive: true });
    writeFileSync(join(workdir, 'src/service.ts'), 'export const value = 1;\n');
    writeFileSync(join(workdir, '.git/HEAD'), 'ref: refs/heads/main\n');
    writeFileSync(join(workdir, spec), '# Final\n\nclosed seam\n');
    writeFileSync(
      join(root, 'trajectory.json'),
      JSON.stringify({
        steps: [
          {
            source: 'agent',
            tool_calls: [
              {
                function_name: 'Edit',
                arguments: {
                  file_path: join(workdir, spec),
                  patch: `*** Begin Patch\n*** Add File: ${join(workdir, spec)}\n+# First\n+\n+open seam\n*** End Patch`,
                },
              },
            ],
          },
        ],
      }),
    );

    const out = join(root, 'blind');
    const result = extractHandoffDrafts(root, spec, out, () => 0);

    expect(result.labels).toEqual({ A: 'initial', B: 'final' });
    expect(readFileSync(join(out, 'A.md'), 'utf8')).toBe(
      '# First\n\nopen seam\n',
    );
    expect(readFileSync(join(out, 'B.md'), 'utf8')).toBe(
      '# Final\n\nclosed seam\n',
    );
    expect(readFileSync(join(out, 'manifest.json'), 'utf8')).not.toContain(
      'self-rating',
    );
    expect(readFileSync(join(out, 'repository/src/service.ts'), 'utf8')).toBe(
      'export const value = 1;\n',
    );
    expect(() => readFileSync(join(out, 'repository', spec), 'utf8')).toThrow();
    expect(() =>
      readFileSync(join(out, 'repository/.git/HEAD'), 'utf8'),
    ).toThrow();
  });
});
