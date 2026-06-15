// list-check-verbs CLI — print the canonical FS check-verb names, one per line.
//
// The sourced bash prelude (src/checks/prelude.sh) loops over this output to
// define one delegating function per verb, so the prelude's vocabulary is
// derived from FS_VERBS rather than hand-listed — drift is impossible by
// construction (a new verb in src/check/dispatch.ts appears here automatically).
//
// `not` is intentionally NOT in FS_VERBS (it is the in-process negation verb on
// check-tool.ts, not a filesystem verb); the prelude adds it explicitly.

import { FS_VERBS } from '../check/dispatch.ts';

for (const verb of Object.keys(FS_VERBS)) {
  console.log(verb);
}
