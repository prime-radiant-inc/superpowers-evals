import { afterEach, expect, test } from 'bun:test';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DiagnosisAssessment } from '../src/experiments/diagnosis/contracts.ts';
import {
  json,
  read,
  sha,
  syntheticAssessment,
} from './fixtures/diagnosis/synthetic-assessment.ts';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'synthetic-assessment-cli-'));
  roots.push(root);
  return { ...syntheticAssessment(root), root };
}
function snapshot(root: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const file of readdirSync(root, {
    recursive: true,
    withFileTypes: true,
  }))
    if (file.isFile()) {
      const path = join(file.parentPath, file.name);
      result[path] = sha(readFileSync(path));
    }
  return result;
}
function cli(args: string[]) {
  const proc = Bun.spawnSync(
    [process.execPath, 'src/cli/diagnosis-assessment.ts', ...args],
    { cwd: join(import.meta.dir, '..'), stdout: 'pipe', stderr: 'pipe' },
  );
  return { exit: proc.exitCode, error: proc.stderr.toString() };
}
for (const [status, exit] of [
  ['pass', 0],
  ['fail', 1],
  ['incomplete', 127],
] as const)
  test(`private CLI retains exact evidence and returns ${exit} for ${status}`, () => {
    const f = fixture();
    if (status === 'fail') f.review.targetSessionId = 'wrong';
    if (status === 'incomplete')
      f.artifacts.errors.push('lost capture fragment');
    f.save();
    json(join(f.runDir, 'verdict.json'), {
      verdict: 'indeterminate',
      sentinel: true,
    });
    const before = {
      ...snapshot(f.runDir),
      ...snapshot(join(f.root, 'private')),
    };
    const output = join(f.root, 'assessment');
    const result = cli([f.runDir, f.keyPath, f.reviewPath, output]);
    expect(result.exit).toBe(exit);
    expect(
      read<DiagnosisAssessment>(join(output, 'assessment.json')).status,
    ).toBe(status);
    expect(readFileSync(join(output, 'report.md'), 'utf8')).toBe(f.report);
    expect(readFileSync(join(output, 'key.json'))).toEqual(
      readFileSync(f.keyPath),
    );
    expect(readFileSync(join(output, 'review.json'))).toEqual(
      readFileSync(f.reviewPath),
    );
    const binding = read<Record<string, string>>(join(output, 'digests.json'));
    expect(binding['reportSha256']).toBe(sha(f.report));
    expect(binding['keySha256']).toBe(sha(readFileSync(f.keyPath)));
    expect(binding['reviewSha256']).toBe(sha(readFileSync(f.reviewPath)));
    expect(readFileSync(join(output, 'assessment.md'), 'utf8')).toContain(
      status,
    );
    expect({
      ...snapshot(f.runDir),
      ...snapshot(join(f.root, 'private')),
    }).toEqual(before);
  });
test('invalid evaluator schema writes incomplete result and preserves raw review', () => {
  const f = fixture();
  const raw = '{"schemaVersion":999}\n';
  writeFileSync(f.reviewPath, raw);
  const output = join(f.root, 'assessment');
  expect(cli([f.runDir, f.keyPath, f.reviewPath, output]).exit).toBe(127);
  expect(
    read<DiagnosisAssessment>(join(output, 'assessment.json')).status,
  ).toBe('incomplete');
  expect(readFileSync(join(output, 'review.json'), 'utf8')).toBe(raw);
});
test('CLI refuses existing assessment directories', () => {
  const f = fixture();
  const output = join(f.root, 'assessment');
  mkdirSync(output);
  writeFileSync(join(output, 'sentinel'), 'untouched');
  expect(cli([f.runDir, f.keyPath, f.reviewPath, output]).exit).toBe(127);
  expect(readdirSync(output)).toEqual(['sentinel']);
});
test('CLI refuses output inside run or private input trees, including directory aliases', () => {
  const f = fixture();
  symlinkSync(f.runDir, join(f.root, 'alias'));
  for (const output of [
    join(f.runDir, 'assessment'),
    join(f.root, 'private', 'assessment'),
    join(f.root, 'alias', 'assessment'),
  ]) {
    expect(cli([f.runDir, f.keyPath, f.reviewPath, output]).exit).toBe(127);
    expect(existsSync(output)).toBe(false);
  }
});
test('usage and missing inputs exit 127 without changing retained run', () => {
  const f = fixture();
  const before = snapshot(f.runDir);
  expect(cli([]).exit).toBe(127);
  expect(
    cli([f.runDir, '/missing/key', f.reviewPath, join(f.root, 'assessment')])
      .exit,
  ).toBe(127);
  expect(snapshot(f.runDir)).toEqual(before);
});

test('CLI retains an unqualified duration key and returns incomplete without assuming its convention', () => {
  const f = fixture();
  delete f.key.quantities[2]!.measurement;
  f.save();
  const output = join(f.root, 'assessment');
  expect(cli([f.runDir, f.keyPath, f.reviewPath, output]).exit).toBe(127);
  const assessment = read<DiagnosisAssessment>(join(output, 'assessment.json'));
  expect(
    assessment.checks.find((check) => check.name === 'key-schema')?.status,
  ).toBe('incomplete');
  expect(readFileSync(join(output, 'key.json'))).toEqual(
    readFileSync(f.keyPath),
  );
});
