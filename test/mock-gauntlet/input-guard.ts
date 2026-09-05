// Local fake grader: dispatch the configured guard, then emit the existing
// provider-free pass fixture. This exercises Quorum's scenario opt-in wiring.
import { spawnSync } from 'node:child_process';

const args = Bun.argv.slice(2);
const index = args.indexOf('--tui-input-guard');
const guard = index < 0 ? undefined : args[index + 1];
if (!guard) throw new Error('Scenario input guard was not passed to Gauntlet');
const result = spawnSync(guard, [], {
  input: '{"name":"type","args":{"text":"yes"}}\n',
});
if (result.status !== 0) throw new Error('Scenario input guard failed');
await import('./mock-gauntlet.ts');
