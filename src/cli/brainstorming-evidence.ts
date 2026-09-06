// Observer commands for the PR 2258 pilot; never invoked by the Coding-Agent.
import { basename, dirname, resolve } from 'node:path';
import { readPinnedNoFollowBytes } from '../appliance/credential-scope.ts';
import {
  captureInput,
  installInputCapture,
  runObserverCommand,
} from '../experiments/brainstorming-input-capture.ts';
import { validateObserverBinding } from '../experiments/observer/binding.ts';
import {
  indexObserverBundle,
  readObserverScore,
} from '../experiments/observer/bundle.ts';
import { readObserverCampaign } from '../experiments/observer/readout.ts';

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
  } else if (command === 'snapshot' && args.length === 1) {
    console.log(JSON.stringify(captureInput(resolve(arg(0)))));
  } else if (command === 'index' && args.length === 1) {
    console.log(JSON.stringify(indexObserverBundle(resolve(arg(0))), null, 2));
  } else if (
    command === 'readout' &&
    (args.length === 2 || args.length === 3)
  ) {
    console.log(
      JSON.stringify(
        readObserverCampaign({
          campaignDir: resolve(arg(0)),
          resultsRoot: resolve(arg(1)),
          ...(args[2] ? { reviewSetPath: resolve(args[2]) } : {}),
        }),
        null,
        2,
      ),
    );
  } else if (command === 'score' && args.length === 1) {
    const score = readObserverScore(resolve(arg(0)));
    console.log(JSON.stringify(score, null, 2));
    process.exitCode =
      score.status === 'pass' ? 0 : score.status === 'fail' ? 1 : 127;
  } else {
    throw new Error(
      'Usage: brainstorming-evidence.ts install RUNNER_BINDING_PATH | observer-index WORKDIR_BASE64 | observer-receipts WORKDIR_BASE64 [CURSOR_BASE64] | observer-read WORKDIR_BASE64 PATH_BASE64 | observer-write-review WORKDIR_BASE64 CONTENT_BASE64 | snapshot WORKDIR | index BUNDLE_DIR | score BUNDLE_DIR | readout CAMPAIGN_DIR RESULTS_ROOT [REVIEW_SET]',
    );
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 127;
}
