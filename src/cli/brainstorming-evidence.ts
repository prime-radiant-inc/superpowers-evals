// Observer commands for the PR 2258 pilot; never invoked by the Coding-Agent.
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import {
  captureArtifact,
  hash,
  indexTranscript,
  scoreEvidenceDirectory,
} from '../experiments/brainstorming-evidence.ts';
import { installInputCapture } from '../experiments/brainstorming-input-capture.ts';

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
    installInputCapture(workdir);
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
- Read each presented saved artifact through your own terminal before replying.
  The installed input guard automatically snapshots Markdown files under
  ${workdir} and the main raw transcript before terminal input and bash calls.
  Receipts are ${join(evidence, 'capture-*.json')}; inspect artifact_path,
  content and after_line to select the matching revision after its presentation
  and before your approval. Reference its filename without .json in review.json.
  No manual snapshot command is required. A capture failure blocks input; wait
  for the current response to settle and retry, or stop with Escape/Ctrl+C.
  Never bypass a guard failure through another process. Keep file reads and
  replies in separate calls; do not edit subject artifacts from your terminal.
  A presented file outside the workspace or a non-Markdown/symlink document
  needs operator review and cannot establish a pass with this instrument.
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
