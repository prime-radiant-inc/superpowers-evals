import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentConfig } from '../contracts/agent-config.ts';
import { envSnapshot, getEnv } from '../env.ts';
import type { CommandRunner } from './command-runner.ts';
import { type CodingAgent, ProvisionError, type RunHome } from './index.ts';

// OpenCode-family provisioning. Ports quorum/runner.py:_seed_opencode_config
// (lines 1111-1206) plus _run_opencode_provider_preflight (lines 864-931).
// provision() is SETUP ONLY: it stages Superpowers into an XDG-isolated OpenCode
// home, pins the model, and runs a throwaway-home provider preflight so the eval
// fails fast if the configured provider cannot answer.
//
// The agent_config_env (OPENCODE_QUORUM_HOME) value IS the opencode_home root in
// the Python: every XDG root and the plugin staging live under home.configDir.

// quorum/runner.py:180 — the pinned model the preflight and the run share, also
// written into opencode.json. Reproduced verbatim.
const OPENCODE_MODEL = 'openai/gpt-5.5';

// quorum/runner.py:175 — OPENCODE_EXPORT_SUBDIR = Path(".quorum/session-exports").
const OPENCODE_EXPORT_SUBDIR = '.quorum/session-exports';

// The session-export glob the stale-export guard scans (coding-agents/opencode.yaml
// session_log_glob). The pre-snapshot stale-export assertion itself is a capture
// (B3) concern — see the NOTE in provision().

// quorum/opencode_capture.py:opencode_env — the XDG-isolation env the OpenCode
// subprocess (and the eval run) receives. provision() returns this map (plus the
// agent_config_env) so gauntlet launches the agent against the isolated home.
function opencodeEnv(opencodeHome: string): Record<string, string> {
  return {
    HOME: opencodeHome,
    XDG_CONFIG_HOME: join(opencodeHome, '.config'),
    XDG_DATA_HOME: join(opencodeHome, '.local', 'share'),
    XDG_STATE_HOME: join(opencodeHome, '.local', 'state'),
    XDG_CACHE_HOME: join(opencodeHome, '.cache'),
    TMPDIR: join(opencodeHome, '.tmp'),
    OPENCODE_CONFIG_DIR: join(opencodeHome, '.config', 'opencode'),
  };
}

// quorum/runner.py:667 — _preflight_response_ok. Normalize trailing punctuation,
// whitespace, and case; accept only a bare "OK", reject empty / verbose replies.
function preflightResponseOk(stdout: string): boolean {
  return (
    stdout
      .trim()
      .replace(/[.!]+$/, '')
      .trim()
      .toUpperCase() === 'OK'
  );
}

export class OpenCodeAgent implements CodingAgent {
  readonly config: AgentConfig;

  // erasableSyntaxOnly forbids `constructor(readonly config)`; assign in body.
  constructor(config: AgentConfig) {
    this.config = config;
  }

  provision(home: RunHome, runner: CommandRunner): Record<string, string> {
    const opencodeHome = home.configDir;

    // _seed_opencode_config: SUPERPOWERS_ROOT is required. Read env ONLY via the
    // sanctioned env module.
    const superpowersRoot = getEnv('SUPERPOWERS_ROOT');
    if (superpowersRoot === undefined || superpowersRoot === '') {
      throw new ProvisionError(
        'SUPERPOWERS_ROOT not set; cannot install opencode Superpowers plugin',
      );
    }

    // NOTE (B3): the Python also does `shutil.which("opencode")` here to fail
    // fast when the binary is absent. PATH probing is a live-run concern; the
    // injected CommandRunner models the opencode invocations, so the integrator
    // can keep the which() guard in the real runner before provision() runs.

    // Verify the required Superpowers OpenCode plugin source files exist.
    const pluginSrc = join(
      superpowersRoot,
      '.opencode',
      'plugins',
      'superpowers.js',
    );
    const required = [
      pluginSrc,
      join(superpowersRoot, 'skills', 'using-superpowers', 'SKILL.md'),
      join(superpowersRoot, 'skills', 'brainstorming', 'SKILL.md'),
    ];
    const missing = required.filter((path) => !existsSync(path));
    if (missing.length > 0) {
      throw new ProvisionError(
        `SUPERPOWERS_ROOT is missing OpenCode plugin files: ${missing.join(', ')}`,
      );
    }

    // NOTE (B3): the Python asserts no stale `[0-9]*-ses_*.json` session exports
    // exist under the export dir before the capture snapshot, and rejects any
    // symlink under SUPERPOWERS_ROOT/skills (_reject_symlinks). The stale-export
    // assertion is a pre-capture snapshot guard owned by the capture stage (B3);
    // it is deliberately not reproduced in this setup-only adapter.

    // Create the XDG-isolated dirs and the session-export dir (the Python loops
    // over exactly these six paths with parents=True, exist_ok=True).
    const opencodeConfigDir = join(opencodeHome, '.config', 'opencode');
    const exportDir = join(opencodeHome, OPENCODE_EXPORT_SUBDIR);
    for (const dir of [
      opencodeConfigDir,
      join(opencodeHome, '.local', 'share', 'opencode'),
      join(opencodeHome, '.local', 'state', 'opencode'),
      join(opencodeHome, '.cache'),
      join(opencodeHome, '.tmp'),
      exportDir,
    ]) {
      mkdirSync(dir, { recursive: true });
    }

    // opencode.json: pin the model so the provider matches the preflight. Not a
    // secret file — written with default mode (parity: the Python writes no
    // mode-0600 secret file for OpenCode; provider keys reach opencode only via
    // the subprocess env, never a quorum-authored file).
    writeFileSync(
      join(opencodeConfigDir, 'opencode.json'),
      `${JSON.stringify(
        {
          $schema: 'https://opencode.ai/config.json',
          model: OPENCODE_MODEL,
        },
        null,
        2,
      )}\n`,
    );

    // Stage the plugin: copy superpowers.js into package_root/.opencode/plugins,
    // copytree skills, then symlink config/plugins/superpowers.js -> staged file.
    const packageRoot = join(opencodeConfigDir, 'superpowers');
    const stagedPlugin = join(
      packageRoot,
      '.opencode',
      'plugins',
      'superpowers.js',
    );
    mkdirSync(join(packageRoot, '.opencode', 'plugins'), { recursive: true });
    cpSync(pluginSrc, stagedPlugin);

    const stagedSkills = join(packageRoot, 'skills');
    if (existsSync(stagedSkills) || isSymlink(stagedSkills)) {
      rmSync(stagedSkills, { recursive: true, force: true });
    }
    cpSync(join(superpowersRoot, 'skills'), stagedSkills, { recursive: true });

    const pluginLinkDir = join(opencodeConfigDir, 'plugins');
    const pluginLink = join(pluginLinkDir, 'superpowers.js');
    mkdirSync(pluginLinkDir, { recursive: true });
    if (existsSync(pluginLink) || isSymlink(pluginLink)) {
      rmSync(pluginLink, { force: true });
    }
    symlinkSync(stagedPlugin, pluginLink);

    // node --check the staged plugin IF node is available (mirror the Python
    // `shutil.which("node")` guard). The integrator passes a runner whose live
    // impl resolves `node`; in the gate the FakeCommandRunner stands in. A
    // non-zero check is a hard ProvisionError.
    const node = getEnv('OPENCODE_NODE_BIN') ?? 'node';
    const nodeCheck = runner.run(node, ['--check', stagedPlugin], {
      env: envSnapshot(),
    });
    if (nodeCheck.status !== 0) {
      throw new ProvisionError(
        `staged OpenCode Superpowers plugin failed node --check: ${nodeCheck.stderr.trim().slice(0, 300)}`,
      );
    }

    // NOTE (B3): the Python additionally calls _require_under_home on the staged
    // plugin, symlink, and every staged-skills path to prove nothing escapes the
    // isolated home. That containment audit is a post-staging integrity check;
    // the integrator can re-add it once the runner owns the home boundary.

    // Provider preflight: throwaway isolated home, retry up to 3x, expect "OK".
    this.runProviderPreflight(runner);

    // Return the env gauntlet passes to the agent CLI: the agent_config_env plus
    // the XDG isolation vars (opencode_env). opencodeHome IS the agent_config_env
    // value, so OPENCODE_QUORUM_HOME and HOME both point at it.
    return {
      [this.config.agent_config_env]: opencodeHome,
      ...opencodeEnv(opencodeHome),
    };
  }

  // Port of _run_opencode_provider_preflight (runner.py 864-931). Builds a
  // throwaway isolated home, probes `opencode --version`, then up to 3x runs
  // `opencode run -m <model> --dangerously-skip-permissions "Reply with EXACTLY
  // OK."` and accepts the first exit-0 "OK" reply. Driven through the injected
  // runner so the gate can stub it.
  private runProviderPreflight(runner: CommandRunner): void {
    const tmp = mkdtempSync(join(tmpdir(), 'quorum-opencode-preflight-'));
    try {
      const cwd = join(tmp, 'cwd');
      const home = join(tmp, 'home');
      mkdirSync(cwd, { recursive: true });
      for (const dir of [
        join(home, '.config', 'opencode'),
        join(home, '.local', 'share', 'opencode'),
        join(home, '.local', 'state', 'opencode'),
        join(home, '.cache'),
        join(home, '.tmp'),
      ]) {
        mkdirSync(dir, { recursive: true });
      }

      const preflightEnv = { ...envSnapshot(), ...opencodeEnv(home) };

      // Version probe (best-effort, like the Python try/except around it). A
      // failed probe only weakens the diagnostic hint, never aborts.
      const version = runner.run('opencode', ['--version'], {
        cwd,
        env: preflightEnv,
      });
      const versionHint =
        (version.stdout || version.stderr).trim() || 'unknown';

      let lastStatus: number | null = null;
      let lastStdout = '';
      let lastStderr = '';
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const result = runner.run(
          'opencode',
          [
            'run',
            '-m',
            OPENCODE_MODEL,
            '--dangerously-skip-permissions',
            'Reply with EXACTLY OK.',
          ],
          { cwd, env: preflightEnv },
        );
        lastStatus = result.status;
        lastStdout = result.stdout;
        lastStderr = result.stderr;
        if (result.status === 0 && preflightResponseOk(result.stdout)) {
          return;
        }
      }

      if (lastStatus !== 0) {
        throw new ProvisionError(
          `opencode provider preflight failed (version ${versionHint.slice(0, 120)}, exit ${lastStatus}); stderr: ${lastStderr.trim().slice(0, 300)}`,
        );
      }
      throw new ProvisionError(
        `opencode provider preflight did not return OK after 3 attempts; version ${versionHint.slice(0, 120)}, stdout: ${lastStdout.trim().slice(0, 300)}, stderr: ${lastStderr.trim().slice(0, 300)}`,
      );
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  }
}

// lstat-based symlink probe that never throws on a missing path (parity with the
// Python `path.is_symlink()` short-circuits used in the staging cleanup).
function isSymlink(path: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
}
