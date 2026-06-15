import { spawnSync } from 'node:child_process';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, isAbsolute, join, resolve } from 'node:path';
import type { AgentConfig } from '../contracts/agent-config.ts';
import { envSnapshot, getEnv } from '../env.ts';
import { agyLogShowsRateLimit } from './agy-watch.ts';
import type { CommandRunner } from './command-runner.ts';
import { type CodingAgent, ProvisionError, type RunHome } from './index.ts';

// Antigravity-family provisioning. Ports the SETUP portion of
// quorum/runner.py:_seed_antigravity_config (lines 800-863), plus its two
// helpers _run_antigravity_auth_preflight (697-767) and
// _write_antigravity_settings (768-799). provision() is SETUP ONLY: it seeds
// the per-run ANTIGRAVITY_CONFIG_DIR/.gemini tree so the agy CLI boots against
// an authenticated, Superpowers-equipped, no-prompt Antigravity workspace.
//
// The Python ceremony has two subprocess interactions, both driven through the
// injected CommandRunner so the hermetic gate stubs them:
//   1. agy auth preflight: a throwaway --gemini_dir + --print "Reply with
//      EXACTLY OK." that validates the Gemini Code Assist backend is reachable
//      and not rate-limited, against isolated state we discard afterward.
//   2. agy plugin install <SUPERPOWERS_ROOT> against the real per-run
//      --gemini_dir, which copies the Superpowers plugin into the .gemini tree.
// Everything else (configDir mkdir, plugin-file verification, settings.json) is
// deterministic file generation, which the gate asserts directly.
//
// agy's hidden --gemini_dir flag is the isolation seam: it relocates the entire
// .gemini state tree (config, plugins, antigravity-cli/{settings,brain}) under
// the per-run config dir so concurrent / repeat runs never share state.

// The marker the runner threads into a setup-stage RunnerError when the Gemini
// Code Assist backend is throttled, so run-all can latch the rate window and
// stop hammering it. Mirrors runner.py ANTIGRAVITY_RATE_LIMIT_MARKER.
export const ANTIGRAVITY_RATE_LIMIT_MARKER = 'Code Assist rate limit';

// The rate-limit log matcher (_agy_log_shows_rate_limit) lives in agy-watch.ts,
// the home of the live tail watcher; this adapter shares that single source so
// the substrings/429-boundary rule never drifts between the two call sites.

// The plugin files agy plugin install must produce under
// .gemini/config/plugins/superpowers/ (mirrors the `required` list in
// _seed_antigravity_config). Relative to the plugin root.
const REQUIRED_PLUGIN_FILES: readonly string[] = [
  'plugin.json',
  'hooks.json',
  join('skills', 'using-superpowers', 'SKILL.md'),
];

// Env override for the parent of the visible-symlink workspace tree, and the
// per-run record file the substitution writes under run_dir. Mirror the Python
// ANTIGRAVITY_VISIBLE_WORKSPACE_ROOT_ENV / ANTIGRAVITY_VISIBLE_LAUNCH_RECORD.
export const ANTIGRAVITY_VISIBLE_WORKSPACE_ROOT_ENV =
  'QUORUM_ANTIGRAVITY_VISIBLE_WORKSPACE_ROOT';
export const ANTIGRAVITY_VISIBLE_LAUNCH_RECORD =
  'antigravity-visible-launch-cwd.json';

// PATH probe for the agy binary. The Python guards `shutil.which("agy") is None`
// in _seed_antigravity_config; we mirror that with Bun.which, behind an
// injectable seam so the hermetic gate (no agy on PATH) can stub it.
type AgyWhichProbe = () => boolean;
const defaultAgyWhich: AgyWhichProbe = () => Bun.which('agy') !== null;
let agyWhichProbe: AgyWhichProbe = defaultAgyWhich;

/** Override the agy PATH probe (tests only). Pass null to restore the default. */
export function setAgyWhichForTesting(probe: AgyWhichProbe | null): void {
  agyWhichProbe = probe ?? defaultAgyWhich;
}

export class AntigravityAgent implements CodingAgent {
  readonly config: AgentConfig;

  constructor(config: AgentConfig) {
    // erasableSyntaxOnly forbids a parameter-property (constructor(readonly
    // config)); assign in the body instead.
    this.config = config;
  }

  provision(home: RunHome, runner: CommandRunner): Record<string, string> {
    const { configDir, workdir } = home;

    // Port of _seed_antigravity_config (SETUP portion only).
    const superpowersRoot = getEnv('SUPERPOWERS_ROOT');
    if (superpowersRoot === undefined || superpowersRoot === '') {
      throw new ProvisionError(
        'SUPERPOWERS_ROOT not set; cannot install antigravity Superpowers plugin',
      );
    }
    // Fail fast with the precise diagnostic when agy is absent, before any work
    // (parity with shutil.which("agy") in _seed_antigravity_config).
    if (!agyWhichProbe()) {
      throw new ProvisionError(
        'agy not found on PATH; cannot run antigravity evals',
      );
    }

    mkdirSync(configDir, { recursive: true });

    // 1. Auth preflight against throwaway state.
    this.runAuthPreflight(runner);

    // 2. agy plugin install <SUPERPOWERS_ROOT> against the real per-run
    //    --gemini_dir, cwd = configDir, with auto-update disabled.
    const geminiDir = join(configDir, '.gemini');
    const installResult = runner.run(
      'agy',
      [`--gemini_dir=${geminiDir}`, 'plugin', 'install', superpowersRoot],
      {
        cwd: configDir,
        env: { ...envSnapshot(), AGY_CLI_DISABLE_AUTO_UPDATE: 'true' },
      },
    );
    if (installResult.status !== 0) {
      throw new ProvisionError(
        `agy plugin install failed (exit ${installResult.status}); stderr: ${installResult.stderr.trim().slice(0, 300)}`,
      );
    }

    // 3. Verify the Superpowers plugin files the Python asserts.
    const pluginRoot = join(geminiDir, 'config', 'plugins', 'superpowers');
    const missing = REQUIRED_PLUGIN_FILES.filter(
      (rel) => !existsSync(join(pluginRoot, rel)),
    );
    if (missing.length > 0) {
      throw new ProvisionError(
        `agy plugin install completed but expected Superpowers plugin files are missing: ${missing.join(', ')}`,
      );
    }

    // 4. Persist no-prompt settings for the isolated run.
    writeAntigravitySettings(configDir, workdir);

    // NOTE (B3, deferred): the Python ends _seed_antigravity_config with a
    // pre-snapshot transcript assertion — _antigravity_transcripts(configDir)
    // must be empty before the capture snapshot, else provisioning leaked a
    // transcript. That guard belongs with the capture/runtime stage, not setup,
    // and depends on the capture snapshot machinery (B3). Left unported here.

    // The env map the Python returns: just the agent_config_env -> configDir.
    // (agy reads its isolated state via the --gemini_dir flag we pass on each
    // CLI invocation, not via an env var, so there are no extra vars.)
    return { [this.config.agent_config_env]: configDir };
  }

  // Port of _run_antigravity_auth_preflight: validate the Gemini Code Assist
  // backend with a throwaway --gemini_dir so the real per-run config dir stays
  // pristine. The Python uses a 90s subprocess timeout; the synchronous
  // CommandRunner has no timeout knob, so the live SpawnCommandRunner inherits
  // the process default and the gate stubs the call entirely. This is a
  // one-shot --print invocation (not a persistent/bidirectional process), so
  // the synchronous seam models it faithfully.
  private runAuthPreflight(runner: CommandRunner): void {
    const tmp = mkdtempSync(join(tmpdir(), 'quorum-antigravity-preflight-'));
    try {
      const cwd = join(tmp, 'cwd');
      mkdirSync(cwd, { recursive: true });
      const geminiDir = join(tmp, '.gemini');
      const logPath = join(tmp, 'agy.log');

      const result = runner.run(
        'agy',
        [
          `--gemini_dir=${geminiDir}`,
          '--dangerously-skip-permissions',
          '--log-file',
          logPath,
          '--print-timeout',
          '60s',
          '--print',
          'Reply with EXACTLY OK.',
        ],
        {
          cwd,
          env: { ...envSnapshot(), AGY_CLI_DISABLE_AUTO_UPDATE: 'true' },
        },
      );

      // A failed preflight — non-zero/null exit OR an empty/garbled reply — is
      // most often the Code Assist quota window being exhausted, which agy
      // surfaces as an empty reply plus 429 / RESOURCE_EXHAUSTED in its log.
      // Diagnose that distinctly (rate-limit marker) so triage doesn't chase a
      // phantom auth bug and run-all can latch the throttled window.
      if (result.status !== 0 || !preflightResponseOk(result.stdout)) {
        let logText = '';
        if (existsSync(logPath)) {
          try {
            logText = readFileSync(logPath, 'utf8');
          } catch {
            logText = '';
          }
        }
        if (agyLogShowsRateLimit(logText, result.stderr)) {
          throw new ProvisionError(
            `${ANTIGRAVITY_RATE_LIMIT_MARKER}: agy returned no usable response and its log shows Code Assist 429 / RESOURCE_EXHAUSTED. The Gemini Code Assist rate/quota window is exhausted; wait for it to refresh before re-running antigravity.`,
          );
        }
        if (result.status !== 0) {
          throw new ProvisionError(
            `antigravity auth preflight failed (exit ${result.status}); check agy browser/keyring auth. stderr: ${result.stderr.trim().slice(0, 300)}`,
          );
        }
        throw new ProvisionError(
          `antigravity auth preflight did not return OK; stdout: ${result.stdout.trim().slice(0, 300)}`,
        );
      }

      // The real agy writes a transcript under the isolated --gemini_dir; its
      // presence proves the --gemini_dir isolation seam took effect. Mirrors the
      // Python glob of <gemini_dir>/antigravity-cli/brain/**/transcript.jsonl.
      const transcripts = antigravityTranscriptsUnder(geminiDir);
      if (transcripts.length === 0) {
        throw new ProvisionError(
          'antigravity auth preflight produced no transcript under isolated --gemini_dir',
        );
      }
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  }
}

// Persist no-prompt settings for the isolated Antigravity run (port of
// _write_antigravity_settings). Parses any existing settings.json (boundary)
// rather than asserting its shape, merges the given workspace into
// trustedWorkspaces (idempotent), and pins the always-proceed permission
// posture. Python calls this TWICE: once at provision time with the workdir,
// and again from the runner after launch-cwd resolution with the RESOLVED
// (possibly visible-aliased) launch cwd — so the agent trusts the actual
// workspace. Exported so the runner (Wave 2b) can perform that second write.
export function writeAntigravitySettings(
  configDir: string,
  workdir: string,
): void {
  const settingsPath = join(
    configDir,
    '.gemini',
    'antigravity-cli',
    'settings.json',
  );
  const settings: Record<string, unknown> = existsSync(settingsPath)
    ? parseSettings(readFileSync(settingsPath, 'utf8'))
    : {};

  // setdefault("trustedWorkspaces", []) then append the run workdir in both its
  // literal and resolved forms (de-duplicated, order-preserving).
  const existingTrusted = settings['trustedWorkspaces'];
  const trusted: string[] = Array.isArray(existingTrusted)
    ? existingTrusted.filter((v): v is string => typeof v === 'string')
    : [];
  for (const trustedWorkspace of [workdir, resolve(workdir)]) {
    if (!trusted.includes(trustedWorkspace)) {
      trusted.push(trustedWorkspace);
    }
  }
  settings['trustedWorkspaces'] = trusted;

  settings['toolPermission'] = 'always-proceed';
  settings['artifactReviewPolicy'] = 'always-proceed';
  settings['permissions'] = {
    allow: [
      'command(*)',
      'unsandboxed(*)',
      'read_file(*)',
      'write_file(*)',
      'read_url(*)',
      'execute_url(*)',
      'mcp(*)',
    ],
    ask: [],
    deny: [],
  };

  mkdirSync(join(configDir, '.gemini', 'antigravity-cli'), {
    recursive: true,
  });
  // json.dumps(settings, indent=2): 2-space indent, no trailing newline.
  writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
}

// Parse an existing settings.json into a plain object. A non-object payload
// (the Python json.loads would yield a non-dict) is unusable as a settings map;
// surface it as a ProvisionError rather than silently discarding it.
function parseSettings(text: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    throw new ProvisionError(
      `antigravity settings.json is not valid JSON: ${String(e)}`,
    );
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new ProvisionError('antigravity settings.json is not a JSON object');
  }
  return parsed as Record<string, unknown>;
}

// Normalize the auth-preflight reply tolerantly (port of
// _preflight_response_ok). The preflight asks agy to "Reply with EXACTLY OK." A
// compliant model occasionally appends punctuation or differs in case; strip
// trailing . and ! plus whitespace and uppercase, but still reject empty
// (rate-limited / dead) or verbose replies.
function preflightResponseOk(stdout: string): boolean {
  return rstripDotBang(stdout.trim()).trim().toUpperCase() === 'OK';
}

// Mirror Python str.rstrip(".!"): strip any trailing run of . or ! characters.
function rstripDotBang(s: string): string {
  let end = s.length;
  while (end > 0) {
    const ch = s[end - 1];
    if (ch === '.' || ch === '!') {
      end -= 1;
    } else {
      break;
    }
  }
  return s.slice(0, end);
}

// Post-run rate-limit detection for the verdict layer. quorum writes the run's
// agy log to <configDir>/agy.log (parity with quorum/runner.py). Scanning the
// log after the run yields the indeterminate VERDICT. Returns the reason string
// when rate-limited, else null.
//
// The live counterparts now exist as modules awaiting runner (Wave 2b) wiring:
// AgyRateLimitWatcher (agy-watch.ts) tails the log mid-run and fires
// killRunTmuxServer (agy-teardown.ts) on the first signal for early teardown;
// backupCredential/verifyOrRestore (agy-creds.ts) guard the shared OAuth token
// around the mid-run kill. This post-run scan stays as the verdict-layer signal.
export function antigravityRateLimitReason(configDir: string): string | null {
  const agyLog = join(configDir, 'agy.log');
  if (!existsSync(agyLog)) {
    return null;
  }
  let logText: string;
  try {
    logText = readFileSync(agyLog, 'utf8');
  } catch {
    return null;
  }
  if (!agyLogShowsRateLimit(logText)) {
    return null;
  }
  return `${ANTIGRAVITY_RATE_LIMIT_MARKER}: the run's agy.log shows Code Assist 429 / RESOURCE_EXHAUSTED. The Gemini Code Assist rate/quota window is exhausted; wait for it to refresh before re-running antigravity.`;
}

// Port of the preflight's transcript glob (a focused
// _antigravity_transcripts on an arbitrary gemini_dir): recursively collect
// **/transcript.jsonl under <geminiDir>/antigravity-cli/brain.
function antigravityTranscriptsUnder(geminiDir: string): string[] {
  const brain = join(geminiDir, 'antigravity-cli', 'brain');
  if (!existsSync(brain)) {
    return [];
  }
  const found: string[] = [];
  walkForTranscripts(brain, found);
  return found.sort();
}

function walkForTranscripts(dir: string, found: string[]): void {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      walkForTranscripts(full, found);
    } else if (entry === 'transcript.jsonl') {
      found.push(full);
    }
  }
}

// True if any component of *path* is a dot-prefixed (hidden) directory. Mirrors
// _path_has_hidden_component: "." and ".." themselves are not hidden.
function pathHasHiddenComponent(path: string): boolean {
  return path
    .split('/')
    .some((part) => part.startsWith('.') && part !== '.' && part !== '..');
}

// Run a read-only git probe under *cwd*. Returns the trimmed stdout and the
// exit status. Used only for the info/exclude marker bookkeeping below; this is
// not an agent-CLI invocation, so it does not route through the CommandRunner
// provisioning seam (matching how setup-helpers/git.ts shells git directly).
export type GitProbe = (
  cwd: string,
  args: readonly string[],
) => { status: number | null; stdout: string };

const gitProbe: GitProbe = (cwd, args) => {
  const proc = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8' });
  return { status: proc.status, stdout: (proc.stdout ?? '').trim() };
};

/**
 * Ignore Antigravity's project marker in the launch repo when one exists.
 *
 * Before launching agy, detect whether *launchCwd* is inside a git work tree
 * and, if so, append `.antigravitycli/` to the repo's git info/exclude
 * (idempotently, honoring an absolute vs relative git-path and trailing-newline
 * normalization). This keeps agy's per-run project marker directory out of the
 * eval repo's git status / dirty-tree assertions. Port of
 * _exclude_antigravity_project_marker. Exported for the runner (Wave 2b).
 */
export function excludeAntigravityProjectMarker(
  launchCwd: string,
  probe: GitProbe = gitProbe,
): void {
  const inside = probe(launchCwd, ['rev-parse', '--is-inside-work-tree']);
  if (inside.status !== 0 || inside.stdout !== 'true') {
    return;
  }

  // Python runs this probe with check=True. A non-zero exit must raise rather
  // than yield "" — an empty git-path collapses excludePath to launchCwd, so the
  // later writeFileSync would target a directory (EISDIR) instead of failing
  // cleanly here.
  const gitPathProbe = probe(launchCwd, [
    'rev-parse',
    '--git-path',
    'info/exclude',
  ]);
  if (gitPathProbe.status !== 0) {
    throw new Error(
      `git rev-parse --git-path info/exclude failed in ${launchCwd} ` +
        `(exit ${gitPathProbe.status})`,
    );
  }
  const gitPath = gitPathProbe.stdout;
  let excludePath = gitPath;
  if (!isAbsolute(excludePath)) {
    excludePath = join(launchCwd, excludePath);
  }
  mkdirSync(join(excludePath, '..'), { recursive: true });
  const existing = existsSync(excludePath)
    ? readFileSync(excludePath, 'utf8').split('\n')
    : [];
  // splitlines() drops the trailing-newline empty element; emulate that for the
  // membership/last-line checks so we match Python's behavior exactly.
  const lines =
    existing.length > 0 && existing[existing.length - 1] === ''
      ? existing.slice(0, -1)
      : existing;
  if (lines.includes('.antigravitycli/')) {
    return;
  }
  const prefix = lines.length > 0 && lines[lines.length - 1] !== '' ? '\n' : '';
  const current = existsSync(excludePath)
    ? readFileSync(excludePath, 'utf8')
    : '';
  writeFileSync(excludePath, `${current}${prefix}.antigravitycli/\n`);
}

/**
 * Return an Antigravity-safe launch cwd.
 *
 * Antigravity rejects `--add-dir` workspaces whose path contains hidden
 * (dot-prefixed) components. Quorum runs often live under `.codex/`, so when
 * *launchCwd* has a hidden component this exposes the same directory through a
 * visible temp symlink alias, validates the visible root is itself non-hidden,
 * reuses an existing matching alias, errors on a conflicting alias, and records
 * the substitution under *runDir*. Port of _prepare_antigravity_launch_cwd.
 * Exported for the runner (Wave 2b).
 */
export function prepareAntigravityLaunchCwd(
  launchCwd: string,
  runDir: string,
): string {
  if (!pathHasHiddenComponent(launchCwd)) {
    return launchCwd;
  }

  const configuredRoot = getEnv(ANTIGRAVITY_VISIBLE_WORKSPACE_ROOT_ENV);
  let visibleRoot =
    configuredRoot !== undefined && configuredRoot !== ''
      ? expandUser(configuredRoot)
      : join(tmpdir(), 'quorum-antigravity-workspaces');
  if (!isAbsolute(visibleRoot)) {
    visibleRoot = resolve(visibleRoot);
  }
  if (pathHasHiddenComponent(visibleRoot)) {
    throw new ProvisionError(
      `${ANTIGRAVITY_VISIBLE_WORKSPACE_ROOT_ENV}=${visibleRoot} contains a ` +
        'hidden path component; Antigravity would reject it as a workspace',
    );
  }

  const aliasParent = join(visibleRoot, basename(runDir));
  mkdirSync(aliasParent, { recursive: true });
  const alias = join(aliasParent, basename(launchCwd) || 'workspace');
  if (existsSync(alias) || isSymlink(alias)) {
    if (isSymlink(alias) && realpathSync(alias) === realpathSync(launchCwd)) {
      return alias;
    }
    throw new ProvisionError(
      `cannot prepare Antigravity visible launch cwd; ${alias} already exists`,
    );
  }

  symlinkSync(realpathSync(launchCwd), alias, 'dir');
  writeFileSync(
    join(runDir, ANTIGRAVITY_VISIBLE_LAUNCH_RECORD),
    JSON.stringify(
      {
        launch_cwd: launchCwd,
        visible_launch_cwd: alias,
        reason: 'Antigravity rejects --add-dir paths with hidden components',
      },
      null,
      2,
    ),
  );
  return alias;
}

// Expand a leading ~ to the user's home dir (Python Path.expanduser parity).
function expandUser(path: string): string {
  if (path === '~') {
    return homedir();
  }
  if (path.startsWith('~/')) {
    return join(homedir(), path.slice(2));
  }
  return path;
}

// True if *path* is a symlink (lstat without following). Tolerates a missing
// path by returning false.
function isSymlink(path: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
}
