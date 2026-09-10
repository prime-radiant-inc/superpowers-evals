// Offline operator command for the session-discovery pilot. It consumes an
// independent reviewer's structured extraction after the subject has stopped;
// it never launches, messages, or otherwise steers the Coding-Agent.
import {
  existsSync,
  lstatSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import {
  basename,
  dirname,
  isAbsolute,
  relative,
  resolve,
  sep,
} from 'node:path';
import { z } from 'zod';
import {
  canonicalizeReportedSourcePath,
  checkDiscoveryAnswer,
  type DiscoveryAnswerKey,
  type DiscoveryCitation,
  type ExtractedDiscoveryAnswer,
} from '../experiments/session-discovery-evidence.ts';

const CitationSchema = z
  .object({
    relativePath: z.string(),
    line: z.number().int(),
    quote: z.string(),
  })
  .strict();

// Passthrough is deliberate. The private extraction may retain review-only
// fields such as the raw absolute path the subject reported, the disposable
// native-log root used to validate it, and the reviewer's extraction and
// entailment judgments. Mechanical checking consumes only this public
// interface and copies the complete private artifact beside the answer key.
const AnswerSchema = z
  .object({
    sessionId: z.string().nullable(),
    sourcePath: z.string().nullable(),
    humanRequests: z.array(z.string()),
    fact: z.string().nullable(),
    citations: z.array(CitationSchema),
    reviewerAudit: z
      .object({
        rawReportedSourcePath: z.string().nullable(),
        nativeLogRoot: z.string().min(1),
        extractionFaithful: z.boolean(),
        entailment: z.string().min(1),
      })
      .passthrough(),
  })
  .passthrough();

const AnswerKeySchema = z
  .object({
    harness: z.enum(['claude', 'codex', 'pi']),
    targetSessionId: z.string().min(1),
    targetRelativePath: z.string().min(1),
    humanRequests: z.array(z.string()),
    expectedFact: z.string().min(1),
    allowedEvidence: z.array(CitationSchema),
  })
  .strict();

function isInside(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return (
    rel !== '' &&
    rel !== '..' &&
    !rel.startsWith(`..${sep}`) &&
    !isAbsolute(rel)
  );
}

function evidenceReader(
  rootPath: string,
): (relativePath: string, line: number) => string | undefined {
  if (!existsSync(rootPath) || !lstatSync(rootPath).isDirectory()) {
    throw new Error(
      'assessment error: retained history path is not a directory',
    );
  }
  const root = realpathSync(rootPath);
  const cache = new Map<string, string[]>();

  return (relativePath: string, line: number): string | undefined => {
    const candidate = resolve(root, relativePath);
    if (!isInside(root, candidate)) return undefined;
    if (!existsSync(candidate)) return undefined;
    const actual = realpathSync(candidate);
    if (!isInside(root, actual)) return undefined;
    if (!lstatSync(actual).isFile()) return undefined;
    let lines = cache.get(actual);
    if (lines === undefined) {
      lines = readFileSync(actual, 'utf8').split(/\r?\n/);
      cache.set(actual, lines);
    }
    return lines[line - 1];
  };
}

function outputStem(answerKeyPath: string): string {
  const name = basename(answerKeyPath);
  return name.endsWith('.json') ? name.slice(0, -5) : name;
}

function usage(): number {
  process.stderr.write(
    'usage: session-discovery-evidence <retained-answer.json> <answer-key.json> <historical-evidence-dir>\n',
  );
  return 127;
}

export function main(argv: readonly string[]): number {
  if (argv.length !== 3) return usage();
  const answerPath = resolve(argv[0] ?? '');
  const answerKeyPath = resolve(argv[1] ?? '');
  const evidenceDir = resolve(argv[2] ?? '');
  const privateDir = dirname(answerKeyPath);
  const stem = outputStem(answerKeyPath);
  const extractionOutput = resolve(
    privateDir,
    `${stem}.reviewer-extraction.json`,
  );
  const resultOutput = resolve(privateDir, `${stem}.mechanical-result.json`);
  let retained: unknown;
  let retainedRead = false;

  try {
    const key = AnswerKeySchema.parse(
      JSON.parse(readFileSync(answerKeyPath, 'utf8')),
    ) as DiscoveryAnswerKey;
    const readLine = evidenceReader(evidenceDir);
    if (!existsSync(answerPath)) {
      retained = {
        sessionId: null,
        sourcePath: null,
        humanRequests: [],
        fact: null,
        citations: [],
        missingRetainedAnswer: true,
      };
      retainedRead = true;
      const checks = checkDiscoveryAnswer(
        {
          sessionId: null,
          sourcePath: null,
          humanRequests: [],
          fact: null,
          citations: [],
        },
        key,
        readLine,
      );
      writeFileSync(extractionOutput, `${JSON.stringify(retained, null, 2)}\n`);
      writeFileSync(
        resultOutput,
        `${JSON.stringify({ checks, passed: false }, null, 2)}\n`,
      );
      for (const check of checks) {
        process.stdout.write(`${JSON.stringify(check)}\n`);
      }
      return 1;
    }
    retained = JSON.parse(readFileSync(answerPath, 'utf8'));
    retainedRead = true;
    const parsed = AnswerSchema.parse(retained);
    if (!isAbsolute(parsed.reviewerAudit.nativeLogRoot)) {
      throw new Error('assessment error: native log root must be absolute');
    }
    if (parsed.reviewerAudit.rawReportedSourcePath === null) {
      if (parsed.sourcePath !== null) {
        throw new Error(
          'assessment error: canonical source path has no raw reported source path',
        );
      }
    } else {
      const canonical = canonicalizeReportedSourcePath(
        parsed.reviewerAudit.rawReportedSourcePath,
        parsed.reviewerAudit.nativeLogRoot,
      );
      if (canonical !== parsed.sourcePath) {
        throw new Error(
          'assessment error: canonical source path does not match the raw reported path under the native log root',
        );
      }
    }
    const answer: ExtractedDiscoveryAnswer = {
      sessionId: parsed.sessionId,
      sourcePath: parsed.sourcePath,
      humanRequests: parsed.humanRequests,
      fact: parsed.fact,
      citations: parsed.citations as DiscoveryCitation[],
    };
    const checks = checkDiscoveryAnswer(answer, key, readLine);
    const passed = checks.every((check) => check.passed);
    writeFileSync(extractionOutput, `${JSON.stringify(retained, null, 2)}\n`);
    writeFileSync(
      resultOutput,
      `${JSON.stringify({ checks, passed }, null, 2)}\n`,
    );
    for (const check of checks)
      process.stdout.write(`${JSON.stringify(check)}\n`);
    return passed ? 0 : 1;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const assessmentError = /^assessment error:/i.test(message)
      ? message
      : `assessment error: ${message}`;
    try {
      if (retainedRead) {
        writeFileSync(
          extractionOutput,
          `${JSON.stringify(retained, null, 2)}\n`,
        );
      }
      writeFileSync(
        resultOutput,
        `${JSON.stringify(
          { checks: [], passed: false, assessment_error: assessmentError },
          null,
          2,
        )}\n`,
      );
    } catch (writeError) {
      process.stderr.write(
        `assessment error: could not save private review result: ${writeError instanceof Error ? writeError.message : String(writeError)}\n`,
      );
    }
    process.stderr.write(`${assessmentError}\n`);
    return 127;
  }
}

if (import.meta.main) {
  process.exit(main(process.argv.slice(2)));
}
