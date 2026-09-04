import { randomUUID } from 'node:crypto';
import { chmodSync, lstatSync } from 'node:fs';
import { join } from 'node:path';
import { defaultLiveSpendLockPath } from '../campaign/locks.ts';
import { loadStateConfig } from './config.ts';
import { writePrivateText } from './fs.ts';
import { withMutationLocks } from './locks.ts';
import { ensurePrivateDirNoFollow } from './safe-fs.ts';

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}
function wrapperSource(configPath: string, root: string): string {
  return `#!/bin/bash -p
set -euo pipefail
default_config=${shellQuote(configPath)}
sanitized_path=/usr/local/bin:/usr/bin:/bin
sanitized_home=${shellQuote(root)}
builtin exec /usr/bin/env -i PATH="$sanitized_path" HOME="$sanitized_home" EVALS_APPLIANCE_CONFIG="$default_config" /bin/bash -s -- "$@" <<'EVALS_APPLIANCE_SANITIZED_SCRIPT'
set -euo pipefail
config="$EVALS_APPLIANCE_CONFIG"
evals_path="$(jq -r '.evals.path' "$config")"
expected_remote="$(jq -r '.evals.remote' "$config")"
expected_ref="$(jq -r '.evals.ref' "$config")"

status="$(git -C "$evals_path" status --porcelain)"
if [[ -n "$status" ]]; then
  printf 'evals-appliance: evals checkout is not clean\n%s\n' "$status" >&2
  exit 1
fi

current="$(git -C "$evals_path" rev-parse --abbrev-ref HEAD)"
if [[ "$current" != "$expected_ref" ]]; then
  printf 'evals-appliance: evals checkout on %s, expected %s\n' "$current" "$expected_ref" >&2
  exit 1
fi

cd "$evals_path"
exec bun run src/appliance/cli.ts "$@"
EVALS_APPLIANCE_SANITIZED_SCRIPT
`;
}
/** The supported installer never removes or changes the canonical ownership configuration. */
export async function installApplianceHelper(
  root: string,
  options: { configPath?: string; canonicalConfigPath?: string } = {},
): Promise<string> {
  const configPath = options.configPath ?? join(root, 'config/appliance.json');
  const canonicalConfigPath =
    options.canonicalConfigPath ?? '/srv/quorum/config/appliance.json';
  if (!lstatSync(canonicalConfigPath, { throwIfNoEntry: false }))
    throw new Error(
      'canonical appliance configuration required before helper installation',
    );
  const loaded = loadStateConfig(configPath);
  if (loaded.config.root !== root)
    throw new Error('installation root differs from configured root');
  defaultLiveSpendLockPath({
    canonicalConfigPath,
    env: { EVALS_APPLIANCE_CONFIG: configPath },
    ...(loaded.config.live_spend_lock
      ? { requestedLockPath: loaded.config.live_spend_lock }
      : {}),
  });
  return withMutationLocks(
    loaded,
    `install-${randomUUID()}`,
    'prepare',
    async () => {
      const bin = join(root, 'bin');
      ensurePrivateDirNoFollow(root, bin, 'helper bin');
      const target = join(bin, 'evals-appliance');
      writePrivateText(target, wrapperSource(configPath, root));
      chmodSync(target, 0o755);
      return target;
    },
  );
}
if (import.meta.main)
  process.stdout.write(
    `${await installApplianceHelper(process.argv[2] ?? '/srv/quorum')}\n`,
  );
