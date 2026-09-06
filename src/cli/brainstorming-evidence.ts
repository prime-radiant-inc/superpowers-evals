// Observer commands for the PR 2258 pilot; never invoked by the Coding-Agent.
import { readFileSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { readPinnedNoFollowBytes } from '../appliance/credential-scope.ts';
import {
  captureArtifact,
  hash,
  indexTranscript,
  scoreEvidenceDirectory,
} from '../experiments/brainstorming-evidence.ts';
import {
  installInputCapture,
  runObserverCommand,
} from '../experiments/brainstorming-input-capture.ts';
import { validateObserverBinding } from '../experiments/observer/binding.ts';

const [command, ...args] = Bun.argv.slice(2);
function arg(index: number): string {
  const value = args[index];
  if (!value) throw new Error(`Missing argument ${index + 1}`);
  return value;
}
try {
  if (command === 'install' && args.length === 1) {
    const path = resolve(arg(0));
    const raw = readPinnedNoFollowBytes(
      dirname(path),
      [basename(path)],
      'runner observer binding',
      true,
    );
    if (!raw) throw new Error('Runner observer binding is unavailable.');
    installInputCapture(
      validateObserverBinding(JSON.parse(raw.toString('utf8'))),
    );
  } else if (
    command?.startsWith('observer-') &&
    (args.length === 1 || args.length === 2)
  ) {
    console.log(JSON.stringify(runObserverCommand(command, arg(0), args[1])));
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
      'Usage: brainstorming-evidence.ts install RUNNER_BINDING_PATH | observer-index WORKDIR_BASE64 | observer-receipts WORKDIR_BASE64 [CURSOR_BASE64] | observer-read WORKDIR_BASE64 PATH_BASE64 | observer-write-review WORKDIR_BASE64 CONTENT_BASE64 | snapshot RAW_LOG ARTIFACT RECEIPT | index RAW_LOG | score EVIDENCE_DIR',
    );
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 127;
}
