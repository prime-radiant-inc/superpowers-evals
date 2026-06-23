// inject-user-preference CLI — writes a user-preference instruction into the
// ambient project-instructions file the coding-agent-under-test honors, so a
// user-override eval can verify the agent suppresses/modifies a skill as the
// preference dictates. The bare verb `inject-user-preference "<text>"` in a
// scenario's setup.sh resolves here via the sourced prelude.
//
// Reads QUORUM_WORKDIR + QUORUM_CODING_AGENT from the environment (the runner
// threads both into setup.sh). Keeps scenarios harness-agnostic: they state the
// preference; the agent→file mapping lives in user-preference.ts.
//
// Exit codes: 2 usage error, 1 missing env / unmapped agent / write failure, 0 ok.

import { getEnv } from '../env.ts';
import { injectUserPreference } from '../setup-helpers/user-preference.ts';

function main(argv: readonly string[]): number {
  const text = argv[0];
  if (text === undefined || text === '') {
    process.stderr.write('usage: inject-user-preference "<preference text>"\n');
    return 2;
  }
  const workdir = getEnv('QUORUM_WORKDIR');
  if (workdir === undefined || workdir === '') {
    process.stderr.write('inject-user-preference: QUORUM_WORKDIR is not set\n');
    return 1;
  }
  const agent = getEnv('QUORUM_CODING_AGENT');
  if (agent === undefined || agent === '') {
    process.stderr.write(
      'inject-user-preference: QUORUM_CODING_AGENT is not set\n',
    );
    return 1;
  }
  try {
    injectUserPreference(workdir, agent, text);
  } catch (err) {
    process.stderr.write(
      `${err instanceof Error ? err.message : String(err)}\n`,
    );
    return 1;
  }
  return 0;
}

if (import.meta.main) {
  process.exit(main(process.argv.slice(2)));
}
