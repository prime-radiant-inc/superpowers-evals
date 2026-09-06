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
function readoutArgs(
  values: string[],
): Parameters<typeof readObserverCampaign>[0] {
  const allowed = new Set(['--campaign-dir', '--results-root', '--review-set']);
  const paths = new Map<string, string>();
  for (let index = 0; index < values.length; index += 2) {
    const flag = values[index];
    const value = values[index + 1];
    if (!flag || !allowed.has(flag))
      throw new Error(`readout arguments: unknown option ${flag ?? ''}`);
    if (paths.has(flag))
      throw new Error(`readout arguments: duplicate ${flag}`);
    if (!value || value.startsWith('--'))
      throw new Error(`readout arguments: missing value for ${flag}`);
    paths.set(flag, value);
  }
  const campaignDir = paths.get('--campaign-dir');
  const resultsRoot = paths.get('--results-root');
  if (!campaignDir || !resultsRoot)
    throw new Error(
      'readout arguments: --campaign-dir and --results-root are required',
    );
  const reviewSetPath = paths.get('--review-set');
  return {
    campaignDir: resolve(campaignDir),
    resultsRoot: resolve(resultsRoot),
    ...(reviewSetPath ? { reviewSetPath: resolve(reviewSetPath) } : {}),
  };
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
    (args.length === 1 ||
      args.length === 2 ||
      (command === 'observer-read' &&
        (args.length === 3 ||
          (args.length === 4 && args[2] === 'receipt-content'))))
  ) {
    console.log(
      JSON.stringify(
        runObserverCommand(
          command,
          arg(0),
          args[1],
          args[2] === 'receipt-content' ? args[3] : args[2],
          args[2] === 'receipt-content' ? 'receipt-content' : undefined,
        ),
      ),
    );
  } else if (command === 'snapshot' && args.length === 1) {
    console.log(JSON.stringify(captureInput(resolve(arg(0)))));
  } else if (command === 'index' && args.length === 1) {
    console.log(JSON.stringify(indexObserverBundle(resolve(arg(0))), null, 2));
  } else if (command === 'readout') {
    console.log(
      JSON.stringify(readObserverCampaign(readoutArgs(args)), null, 2),
    );
  } else if (command === 'score' && args.length === 1) {
    const score = readObserverScore(resolve(arg(0)));
    console.log(JSON.stringify(score, null, 2));
    process.exitCode =
      score.status === 'pass' ? 0 : score.status === 'fail' ? 1 : 127;
  } else {
    throw new Error(
      'Usage: brainstorming-evidence.ts install RUNNER_BINDING_PATH | observer-index WORKDIR_BASE64 [CURSOR_BASE64] | observer-receipts WORKDIR_BASE64 [CURSOR_BASE64] | observer-read WORKDIR_BASE64 PATH_BASE64 [receipt-content] [CURSOR_BASE64] | observer-write-review WORKDIR_BASE64 CONTENT_BASE64 | snapshot WORKDIR | index BUNDLE_DIR | score BUNDLE_DIR | readout --campaign-dir PATH --results-root PATH [--review-set PATH]',
    );
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 127;
}
