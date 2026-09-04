import { afterEach, expect, test } from 'bun:test';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { installApplianceHelper } from '../src/appliance/install.ts';
import { lifecycleFixture } from './fixtures/core-comparison/lifecycle.ts';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const f = lifecycleFixture();
  roots.push(f.root);
  return f;
}
test('supported helper replacement retains canonical config and refuses an unresolved claim', async () => {
  const f = fixture();
  const config = readFileSync(f.loaded.configPath);
  const opts = {
    configPath: f.loaded.configPath,
    canonicalConfigPath: f.loaded.configPath,
  };
  const target = await installApplianceHelper(f.root, opts);
  const wrapper = readFileSync(target);
  writeFileSync(`${f.loaded.config.live_spend_lock}.claim.json`, '{invalid');
  await expect(installApplianceHelper(f.root, opts)).rejects.toThrow();
  expect(readFileSync(target)).toEqual(wrapper);
  expect(readFileSync(f.loaded.configPath)).toEqual(config);
});
test('custom installation cannot introduce a second lock authority', async () => {
  const f = fixture();
  const foreign = join(f.root, 'foreign.json');
  writeFileSync(
    foreign,
    JSON.stringify({
      ...f.loaded.config,
      live_spend_lock: join(f.root, 'other.lock'),
    }),
  );
  await expect(
    installApplianceHelper(f.root, {
      configPath: foreign,
      canonicalConfigPath: f.loaded.configPath,
    }),
  ).rejects.toThrow(/disagrees/);
  expect(existsSync(join(f.root, 'bin/evals-appliance'))).toBe(false);
});
