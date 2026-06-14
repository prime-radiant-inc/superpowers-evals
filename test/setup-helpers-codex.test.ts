import { describe, expect, test } from 'bun:test';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import type {
  CommandResult,
  CommandRunner,
} from '../src/agents/command-runner.ts';
import { installCodexSuperpowersPluginHooks } from '../src/setup-helpers/worktree.ts';

class CodexRunner implements CommandRunner {
  run(): CommandResult {
    return { status: 0, stdout: '', stderr: '' };
  }
}

function fakeSuperpowers(): string {
  const root = mkdtempSync(join(tmpdir(), 'sh-sp-'));
  mkdirSync(join(root, 'skills'), { recursive: true });
  writeFileSync(join(root, 'skills', 'x.md'), 'hi\n');
  mkdirSync(join(root, '.git'), { recursive: true }); // must be IGNORED everywhere
  writeFileSync(join(root, '.git', 'HEAD'), 'ref\n');
  // A nested dir literally named `evals` with a `results/` child: copytree
  // prunes `results` ONLY inside a dir whose basename is `evals`, at any depth.
  mkdirSync(join(root, 'evals', 'results'), { recursive: true });
  writeFileSync(join(root, 'evals', 'results', 'junk.txt'), 'x\n'); // pruned
  writeFileSync(join(root, 'evals', 'keep.txt'), 'y\n'); // copied
  return root;
}

describe('installCodexSuperpowersPluginHooks', () => {
  test('copies plugin (ignore filter), writes config, trusts hook, sets DRILL_CODEX_HOME', async () => {
    const parent = mkdtempSync(join(tmpdir(), 'sh-cx-'));
    const sp = fakeSuperpowers();
    const wd = join(parent, 'wd');
    mkdirSync(wd, { recursive: true });
    const captured: Record<string, string> = {}; // capture, not process.env (noProcessEnv)
    try {
      await installCodexSuperpowersPluginHooks(
        { workdir: wd, superpowersRoot: sp, run: new CodexRunner() } as never,
        {
          login: () => {},
          queryHook: async () => ({ key: 'k"1', currentHash: 'h\\2' }),
          setEnv: (k, v) => {
            captured[k] = v;
          },
        },
      );
      const home = join(dirname(wd), `${basename(wd)}-codex-home`);
      const pluginRoot = join(home, 'plugins/cache/debug/superpowers/local');
      expect(existsSync(join(pluginRoot, 'skills/x.md'))).toBe(true);
      expect(existsSync(join(pluginRoot, '.git'))).toBe(false); // ignored everywhere
      expect(existsSync(join(pluginRoot, 'evals/keep.txt'))).toBe(true); // evals/ copied
      expect(existsSync(join(pluginRoot, 'evals/results'))).toBe(false); // results/ pruned in evals/
      const config = await Bun.file(join(home, 'config.toml')).text();
      expect(config).toContain('plugin_hooks = true');
      expect(config).toContain('[plugins."superpowers@debug"]');
      // _toml_basic_string escapes `\`->`\\` then `"`->`\"`. Cover BOTH branches:
      expect(config).toContain('[hooks.state."k\\"1"]'); // quote in key escaped
      expect(config).toContain('trusted_hash = "h\\\\2"'); // backslash in hash escaped
      expect(captured['DRILL_CODEX_HOME']).toBe(home);
    } finally {
      rmSync(parent, { recursive: true, force: true });
      rmSync(sp, { recursive: true, force: true });
    }
  });
});
