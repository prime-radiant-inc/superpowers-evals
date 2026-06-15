import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import type { AgentConfig } from '../contracts/agent-config.ts';
import { envSnapshot, getEnv } from '../env.ts';
import type { CommandRunner } from './command-runner.ts';
import { type CodingAgent, ProvisionError, type RunHome } from './index.ts';
import {
  defaultSpawn,
  OpenCodeTimeoutError,
  opencodeEnv,
  runOpencodeCommand,
  type SpawnFn,
} from './opencode-capture.ts';

// OpenCode-family provisioning. Ports quorum/runner.py:_seed_opencode_config
// (lines 1174-1271) plus _run_opencode_provider_preflight (lines 864-931).
// provision() is SETUP ONLY: it stages Superpowers into an XDG-isolated OpenCode
// home, pins the model, and runs a throwaway-home provider preflight so the eval
// fails fast if the configured provider cannot answer.
//
// The agent_config_env (OPENCODE_QUORUM_HOME) value IS the opencode_home root:
// every XDG root and the plugin staging live under home.configDir. With
// opencode.yaml's `home_config_subdir: "."`, home.configDir IS the per-run
// throwaway $HOME (runHomeDir), so the agent finds its config via its $HOME
// default and the launcher need not set OPENCODE_QUORUM_HOME. opencode keys its
// session DB off XDG_DATA_HOME (= <home>/.local/share), so this home is also the
// session store the capture subprocess (opencodeEnv, same home) reads.

// quorum/runner.py:180 — the pinned model the preflight and the run share, also
// written into opencode.json. Reproduced verbatim.
const OPENCODE_MODEL = 'openai/gpt-5.5';

// quorum/runner.py:175 — OPENCODE_EXPORT_SUBDIR = Path(".quorum/session-exports").
const OPENCODE_EXPORT_SUBDIR = '.quorum/session-exports';

// quorum/runner.py:1198 — the stale-export glob (coding-agents/opencode.yaml
// session_log_glob): files named `<16-digit created>-ses_<id>.json`.
const STALE_EXPORT_RE = /^[0-9].*-ses_.*\.json$/;

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

// lstat-based symlink probe that never throws on a missing path (parity with the
// Python `path.is_symlink()` short-circuits).
function isSymlink(path: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
}

// quorum/runner.py:1181-1206 _reject_symlinks: refuse any symlink under `root`
// (recursively). A missing root is fine — the required-files check reports it.
function rejectSymlinks(root: string, label: string): void {
  if (isSymlink(root)) {
    throw new ProvisionError(`${label} contains unsupported symlink: ${root}`);
  }
  if (!existsSync(root) || !statSync(root).isDirectory()) {
    return;
  }
  for (const entry of readdirSync(root)) {
    rejectSymlinks(join(root, entry), label);
  }
}

// quorum/runner.py:1006 _require_under_home: a staged path must resolve under the
// isolated opencode_home (no escape via symlink or traversal).
function requireUnderHome(path: string, opencodeHome: string): void {
  const homeReal = resolve(opencodeHome);
  const pathReal = resolve(path);
  const rel = relative(homeReal, pathReal);
  if (rel.startsWith('..') || rel.startsWith('/')) {
    throw new ProvisionError(
      `staged OpenCode Superpowers path escapes isolated home: ${path}`,
    );
  }
}

// Recursively yield every path under `root` (depth-first), for the under-home
// containment audit (parity with the Python `rglob("*")`).
function* walk(root: string): Generator<string> {
  if (!existsSync(root) || !statSync(root).isDirectory()) {
    return;
  }
  for (const entry of readdirSync(root)) {
    const child = join(root, entry);
    yield child;
    if (!isSymlink(child) && statSync(child).isDirectory()) {
      yield* walk(child);
    }
  }
}

// quorum/runner.py:1181-1182 / 1247 — PATH lookups, mirroring shutil.which.
// Bun.which resolves a real PATH entry; a `command -v` shell builtin ENOENTs on
// Linux (no `command` executable) and would falsely report not-found
// (H3-opencode-command-v-probe-false-not-found).
function binaryOnPath(binary: string): boolean {
  return Bun.which(binary, { PATH: envSnapshot()['PATH'] ?? '' }) !== null;
}

export class OpenCodeAgent implements CodingAgent {
  readonly config: AgentConfig;
  // Injectable opencode subprocess seam (the file-stdout / allowlist-env path).
  // resolveAgent constructs with one arg, so live runs get defaultSpawn; tests
  // pass a fake that records the preflight invocations.
  private readonly spawn: SpawnFn;

  // erasableSyntaxOnly forbids `constructor(readonly config)`; assign in body.
  constructor(config: AgentConfig, spawn: SpawnFn = defaultSpawn) {
    this.config = config;
    this.spawn = spawn;
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

    // quorum/runner.py:1181-1182 — fail fast when the opencode binary is absent,
    // before any staging, so a missing binary yields a precise diagnostic instead
    // of an opaque downstream preflight spawn failure.
    if (!binaryOnPath('opencode')) {
      throw new ProvisionError(
        'opencode not found on PATH; cannot run opencode evals',
      );
    }

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

    // quorum/runner.py:1198-1205 — refuse to proceed if pre-existing session
    // exports already sit under the export dir before the capture snapshot, so a
    // prior run's exports cannot be mis-attributed to this run.
    const exportDir = join(opencodeHome, OPENCODE_EXPORT_SUBDIR);
    const staleExports = existsSync(exportDir)
      ? readdirSync(exportDir)
          .filter((name) => STALE_EXPORT_RE.test(name))
          .sort()
          .map((name) => join(exportDir, name))
      : [];
    if (staleExports.length > 0) {
      throw new ProvisionError(
        `pre-existing OpenCode session exports before capture snapshot: ${staleExports
          .slice(0, 3)
          .join(', ')}`,
      );
    }

    // quorum/runner.py:1207 — reject any symlink under SUPERPOWERS_ROOT/skills
    // before copying it into the isolated home.
    rejectSymlinks(join(superpowersRoot, 'skills'), 'SUPERPOWERS_ROOT skills');

    // Create the XDG-isolated dirs and the session-export dir (the Python loops
    // over exactly these six paths with parents=True, exist_ok=True).
    const opencodeConfigDir = join(opencodeHome, '.config', 'opencode');
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

    // node --check the staged plugin ONLY when node is on PATH (mirror the Python
    // `shutil.which("node")` guard: a host without node skips the check and
    // proceeds, rather than failing on an unspawnable binary). A non-zero check
    // when node IS present is a hard ProvisionError.
    if (binaryOnPath('node')) {
      const node = getEnv('OPENCODE_NODE_BIN') ?? 'node';
      const nodeCheck = runner.run(node, ['--check', stagedPlugin], {
        env: envSnapshot(),
      });
      if (nodeCheck.status !== 0) {
        throw new ProvisionError(
          `staged OpenCode Superpowers plugin failed node --check: ${nodeCheck.stderr.trim().slice(0, 300)}`,
        );
      }
    }

    // quorum/runner.py:1261-1265 — prove the staged plugin, the plugin symlink,
    // the staged skills dir, and every file beneath it resolve under the isolated
    // home (no escape via symlink or traversal).
    requireUnderHome(stagedPlugin, opencodeHome);
    requireUnderHome(pluginLink, opencodeHome);
    requireUnderHome(stagedSkills, opencodeHome);
    for (const path of walk(stagedSkills)) {
      requireUnderHome(path, opencodeHome);
    }

    // Provider preflight: throwaway isolated home, retry up to 3x, expect "OK".
    this.runProviderPreflight();

    // Return the extra-env the runner threads into the run: the agent_config_env
    // (OPENCODE_QUORUM_HOME) plus the XDG isolation vars (opencode_env).
    // opencodeHome IS the agent_config_env value, so OPENCODE_QUORUM_HOME and HOME
    // both point at it. The runner resolves session_log_dir against this map
    // (${OPENCODE_QUORUM_HOME}/.quorum/session-exports); the launcher pins HOME via
    // $QUORUM_HOME_ENV (= the same home) rather than reading OPENCODE_QUORUM_HOME.
    return {
      [this.config.agent_config_env]: opencodeHome,
      ...opencodeEnv(opencodeHome),
    };
  }

  // Port of _run_opencode_provider_preflight (runner.py 864-931). Builds a
  // throwaway isolated home, probes `opencode --version`, then up to 3x runs
  // `opencode run -m <model> --dangerously-skip-permissions "Reply with EXACTLY
  // OK."` and accepts the first exit-0 "OK" reply. Drives opencode through
  // runOpencodeCommand (regular-file stdout + allowlisted env) so the bare
  // process.exit() cannot truncate the reply and no host vars leak in.
  private runProviderPreflight(): void {
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

      // Version probe (best-effort, like the Python try/except). A failed probe
      // only weakens the diagnostic hint, never aborts.
      let versionHint = 'unknown';
      try {
        const version = runOpencodeCommand(['--version'], {
          opencodeHome: home,
          launchCwd: cwd,
          timeoutMs: 15_000,
          spawn: this.spawn,
        });
        versionHint = (version.stdout || version.stderr).trim() || 'unknown';
      } catch {
        // best-effort
      }

      let lastExit: number | null = null;
      let lastStdout = '';
      let lastStderr = '';
      for (let attempt = 0; attempt < 3; attempt += 1) {
        let result: ReturnType<typeof runOpencodeCommand>;
        try {
          result = runOpencodeCommand(
            [
              'run',
              '-m',
              OPENCODE_MODEL,
              '--dangerously-skip-permissions',
              'Reply with EXACTLY OK.',
            ],
            {
              opencodeHome: home,
              launchCwd: cwd,
              timeoutMs: 90_000,
              spawn: this.spawn,
            },
          );
        } catch (e) {
          // quorum/runner.py:_run_opencode_provider_preflight — a TimeoutExpired
          // raises on the FIRST timeout; it is NOT swallowed and retried. Surface
          // it as a setup-stage ProvisionError with the same message.
          if (e instanceof OpenCodeTimeoutError) {
            throw new ProvisionError(
              'opencode provider preflight timed out after 90s',
            );
          }
          throw e;
        }
        lastExit = result.exitCode;
        lastStdout = result.stdout;
        lastStderr = result.stderr;
        if (result.exitCode === 0 && preflightResponseOk(result.stdout)) {
          return;
        }
      }

      if (lastExit !== 0) {
        throw new ProvisionError(
          `opencode provider preflight failed (version ${versionHint.slice(0, 120)}, exit ${lastExit}); stderr: ${lastStderr.trim().slice(0, 300)}`,
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
