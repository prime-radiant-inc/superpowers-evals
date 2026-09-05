// Observer commands for the PR 2258 pilot; never invoked by the Coding-Agent.
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import {
  captureArtifact,
  hash,
  indexTranscript,
  scoreEvidenceDirectory,
} from '../experiments/brainstorming-evidence.ts';

const [command, ...args] = Bun.argv.slice(2);
function arg(index: number): string {
  const value = args[index];
  if (!value) throw new Error(`Missing argument ${index + 1}`);
  return value;
}
try {
  if (command === 'install' && args.length === 1) {
    const workdir = resolve(arg(0));
    const runDir = dirname(workdir);
    const context = join(runDir, 'gauntlet-agent', 'context');
    const evidence = join(runDir, 'brainstorming-evidence');
    mkdirSync(context, { recursive: true });
    mkdirSync(evidence, { recursive: true });
    copyFileSync(
      new URL(
        '../../scenarios/brainstorming-todo-shared-intent/observer.md',
        import.meta.url,
      ),
      join(context, 'BRAINSTORMING-ANNOTATIONS.md'),
    );
    const cli = `bun ${JSON.stringify(import.meta.path)}`;
    writeFileSync(
      join(context, 'BRAINSTORMING-OBSERVER.md'),
      `# Private observer instructions

Keep this file and all evidence out of the Coding-Agent workspace and messages.
Follow the story's actor policy. Use your own terminal to read the real files.
Locate the main Codex rollout using HOWTO.md. Keep its absolute path as RAW_LOG.
These commands are for your terminal, never the subject's terminal:

- Index the completed raw log: ${cli} index RAW_LOG
- Before approving each presented saved artifact, capture and read it:
  ${cli} snapshot RAW_LOG ARTIFACT_PATH ${JSON.stringify(join(evidence, 'spec-1.json'))}
  Use plan-1.json for the plan; use a new name for every later revision.
  ARTIFACT_PATH is the actual presented file, usually inside ${workdir}.
  The command prints the captured contents for your review. If the log is being
  written, wait for the current response to settle and retry. Never approve first.
- After stopping, index the complete main log. Write ${join(evidence, 'review.json')}
  with {"raw_log":"absolute main rollout path","review":{...}}. The review schema
  and annotation examples are in BRAINSTORMING-ANNOTATIONS.md; the index prints
  raw_sha256, numbered messages, call IDs, arguments, and an empty review template.
- Validate: ${cli} score ${JSON.stringify(evidence)}

Classify every call, including shell writes, scaffolds, dependency installation,
and implementation delegation. Review the raw outputs to mark success. Process
means bookkeeping, skill reads, or document review, never product work. If a
call mixes effects, list ALL effects and the actual changed_artifacts, even if
the overall shell command fails. Unresolved effects are unknown, not read_only. Empty or incomplete notes
cannot establish a pass. Keep the original Gauntlet verdict and the audit sidecar.
`,
      { flag: 'wx' },
    );
  } else if (command === 'snapshot' && args.length === 3) {
    captureArtifact(arg(0), arg(1), arg(2));
    console.log(readFileSync(arg(2), 'utf8'));
  } else if (command === 'index' && args.length === 1) {
    const raw = readFileSync(arg(0), 'utf8');
    console.log(
      JSON.stringify(
        {
          raw_sha256: hash(raw),
          entries: indexTranscript(raw),
          template: {
            raw_log: resolve(arg(0)),
            review: {
              schema_version: 1,
              raw_sha256: hash(raw),
              reviewer: 'Gauntlet-Agent',
              stop_reason: 'endpoint',
              events: [],
              actions: [],
            },
          },
        },
        null,
        2,
      ),
    );
  } else if (command === 'score' && args.length === 1) {
    const score = scoreEvidenceDirectory(arg(0));
    console.log(JSON.stringify(score, null, 2));
    process.exitCode =
      score.status === 'pass' ? 0 : score.status === 'fail' ? 1 : 127;
  } else {
    throw new Error(
      'Usage: brainstorming-evidence.ts install WORKDIR | snapshot RAW_LOG ARTIFACT RECEIPT | index RAW_LOG | score EVIDENCE_DIR',
    );
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 127;
}
