// Private offline operator command. Never included in subject/worker checks.
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import {
  assessDiagnosis,
  diagnosisDigest,
  readDiagnosisFile,
} from '../experiments/diagnosis/assessment.ts';
import {
  DiagnosisArtifactsSchema,
  type DiagnosisAssessment,
  DiagnosisReviewSchema,
} from '../experiments/diagnosis/contracts.ts';

function inside(root: string, path: string): boolean {
  const rel = relative(root, path);
  return (
    rel === '' ||
    (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
  );
}
function projectedRealPath(path: string): string {
  if (existsSync(path)) return realpathSync(path);
  const parent = dirname(path);
  if (parent === path) throw new Error('output has no existing ancestor');
  return resolve(projectedRealPath(parent), relative(parent, path));
}
export function main(argv: readonly string[]): number {
  if (argv.length !== 4) {
    process.stderr.write(
      'usage: diagnosis-assessment <retained-run-dir> <key.json> <review.json> <output-dir>\n',
    );
    return 127;
  }
  try {
    const runDir = realpathSync(resolve(argv[0] ?? ''));
    const keyPath = realpathSync(resolve(argv[1] ?? ''));
    const reviewPath = realpathSync(resolve(argv[2] ?? ''));
    const output = resolve(argv[3] ?? '');
    const actualOutput = projectedRealPath(output);
    if (
      existsSync(output) ||
      [runDir, dirname(keyPath), dirname(reviewPath)].some((root) =>
        inside(root, actualOutput),
      )
    )
      throw new Error(
        'assessment output must be new and outside retained input trees',
      );
    if (!lstatSync(keyPath).isFile() || !lstatSync(reviewPath).isFile())
      throw new Error('key and review must be regular files');
    const keyBytes = readFileSync(keyPath);
    const reviewBytes = readFileSync(reviewPath);
    let assessment: DiagnosisAssessment;
    try {
      assessment = assessDiagnosis({ runDir, keyPath, reviewPath });
    } catch (error) {
      assessment = {
        status: 'incomplete',
        checks: [
          {
            name: 'evaluator-input',
            status: 'incomplete',
            detail: error instanceof Error ? error.message : String(error),
          },
        ],
      };
    }
    let reportBytes: Buffer | undefined;
    let reportPath: string | undefined;
    try {
      const review = DiagnosisReviewSchema.parse(
        JSON.parse(reviewBytes.toString('utf8')),
      );
      const artifacts = DiagnosisArtifactsSchema.parse(
        JSON.parse(
          readDiagnosisFile(runDir, 'diagnosis-artifacts.json').toString(
            'utf8',
          ),
        ),
      );
      const row = artifacts.files.find(
        (file) => file.originalPath === review.reportPath,
      );
      if (row) {
        reportBytes = readDiagnosisFile(runDir, row.retainedPath);
        reportPath = review.reportPath;
      }
    } catch {
      /* Invalid/partial evidence is recorded by the assessment; retain raw review. */
    }
    // Snapshot all input bytes before creating the reviewable output directory.
    mkdirSync(dirname(actualOutput), { recursive: true });
    mkdirSync(actualOutput, { mode: 0o700 });
    const write = (name: string, bytes: string | Buffer) =>
      writeFileSync(join(actualOutput, name), bytes, {
        flag: 'wx',
        mode: 0o600,
      });
    write('key.json', keyBytes);
    write('review.json', reviewBytes);
    if (reportBytes) write('report.md', reportBytes);
    write(
      'digests.json',
      `${JSON.stringify({ schemaVersion: 1, runDir, reportPath: reportPath ?? null, reportSha256: reportBytes ? diagnosisDigest(reportBytes) : null, keySha256: diagnosisDigest(keyBytes), reviewSha256: diagnosisDigest(reviewBytes) }, null, 2)}\n`,
    );
    write('assessment.json', `${JSON.stringify(assessment, null, 2)}\n`);
    const adverse = assessment.checks.filter(
      (check) => check.status !== 'pass',
    );
    write(
      'assessment.md',
      `# Diagnosis assessment\n\nStatus: **${assessment.status}**. ${assessment.checks.length} checks retained.\n\nIndependent reviewer judgments remain in review.json; deterministic checks do not establish prose entailment.\n\n${adverse.map((check) => `- ${check.status}: ${check.name} — ${check.detail.replace(/\n/g, ' ')}`).join('\n')}\n`,
    );
    process.stdout.write(`${assessment.status}: ${actualOutput}\n`);
    return assessment.status === 'pass'
      ? 0
      : assessment.status === 'fail'
        ? 1
        : 127;
  } catch (error) {
    process.stderr.write(
      `assessment error: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    return 127;
  }
}
if (import.meta.main) process.exit(main(process.argv.slice(2)));
