import { spawnSync } from 'node:child_process';
import {
  chmodSync,
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
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import type { AgentConfig } from '../contracts/agent-config.ts';
import { getEnv } from '../env.ts';
import { stageSuperpowersPlugin } from '../setup-helpers/plugin-stage.ts';
import { agyLogShowsRateLimit } from './agy-watch.ts';
import type { CommandResult, CommandRunner } from './command-runner.ts';
import { type CodingAgent, ProvisionError, type RunHome } from './index.ts';
import { provisionSubprocessEnv } from './subprocess-env.ts';
import { resolveSuperpowersRoot } from './superpowers.ts';

// Antigravity-family provisioning. provision() is SETUP ONLY: it seeds the
// per-run ANTIGRAVITY_CONFIG_DIR/.gemini tree so the agy CLI boots against an
// authenticated, Superpowers-equipped, no-prompt Antigravity workspace.
//
// The explicit per-run runtime token (AGY_RUNTIME_OAUTH_TOKEN) is validated
// and seeded FIRST — before any agy subprocess — and every agy subprocess
// runs with HOME/config routing pinned to the isolated run home (F13), so agy
// authenticates with the seeded token and can never consult the operator's
// real ~/.gemini or per-login-user keyring.
//
// The setup has two subprocess interactions, both driven through the injected
// CommandRunner so the hermetic gate stubs them:
//   1. agy auth preflight: a throwaway --gemini_dir (under the run home,
//      seeded with the per-run token) + --print "Reply with EXACTLY OK." that
//      validates the Gemini Code Assist backend is reachable and not
//      rate-limited, against isolated state we discard afterward.
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
// stop hammering it.
export const ANTIGRAVITY_RATE_LIMIT_MARKER = 'Code Assist rate limit';

// The rate-limit log matcher lives in agy-watch.ts, the home of the live tail
// watcher; this adapter shares that single source so the substrings/429-boundary
// rule never drifts between the two call sites.

// The plugin files agy plugin install must produce under
// .gemini/config/plugins/superpowers/. Relative to the plugin root.
const REQUIRED_PLUGIN_FILES: readonly string[] = [
  'plugin.json',
  'hooks.json',
  join('skills', 'using-superpowers', 'SKILL.md'),
];

// C1 OAuth-creds seed (spec docs/superpowers/specs/2026-06-15-per-run-home-
// isolation.md §5C). agy reads its live OAuth token from
// $HOME/.gemini/antigravity-cli/antigravity-oauth-token at RUNTIME — NOT from
// oauth_creds.json (that file is Gemini-personal mode; agy ignores it, and it
// carries an UNRELATED operator credential, so it must never enter the
// agent-readable run home). The nested token is the WHOLE runtime credential
// contract: it is the only file seeded.
export const AGY_RUNTIME_OAUTH_TOKEN = join(
  'antigravity-cli',
  'antigravity-oauth-token',
);

// Copy agy's runtime OAuth token from the REAL home's .gemini into the per-run
// .gemini at mode 0600. The source home is AGY_OAUTH_HOME (the test / operator
// override) else ~/.gemini. Returns false when the source token is absent —
// the criticality policy (fail before any agy subprocess) lives in
// provision().
// Bun's homedir() snapshots the REAL $HOME at startup and ignores quorum's own
// per-subprocess HOME pin, so this always reads the operator's real ~/.gemini.
export function seedAgyRuntimeToken(configDir: string): boolean {
  const sourceHome = getEnv('AGY_OAUTH_HOME') ?? join(homedir(), '.gemini');
  const source = join(sourceHome, AGY_RUNTIME_OAUTH_TOKEN);
  if (!statSync(source, { throwIfNoEntry: false })?.isFile()) {
    return false;
  }
  const dest = join(configDir, '.gemini', AGY_RUNTIME_OAUTH_TOKEN);
  mkdirSync(dirname(dest), { recursive: true });
  // writeFileSync's `mode` only applies on create; chmod after to enforce
  // 0600 even when the file already existed.
  writeFileSync(dest, readFileSync(source, 'utf8'), { mode: 0o600 });
  chmodSync(dest, 0o600);
  return true;
}

// The env every agy provisioning subprocess runs under (F13): the non-secret
// provisioning allowlist with HOME and XDG config routing pinned to the
// isolated run home, so agy resolves the seeded per-run token and can never
// consult the operator's real ~/.gemini or per-login-user keyring state.
function antigravitySubprocessEnv(configDir: string): Record<string, string> {
  return provisionSubprocessEnv({
    HOME: configDir,
    XDG_CONFIG_HOME: join(configDir, '.config'),
    AGY_CLI_DISABLE_AUTO_UPDATE: 'true',
  });
}

// Env override for the parent of the visible-symlink workspace tree, and the
// per-run record file the substitution writes under run_dir.
export const ANTIGRAVITY_VISIBLE_WORKSPACE_ROOT_ENV =
  'QUORUM_ANTIGRAVITY_VISIBLE_WORKSPACE_ROOT';
export const ANTIGRAVITY_VISIBLE_LAUNCH_RECORD =
  'antigravity-visible-launch-cwd.json';

// PATH probe for the agy binary, via Bun.which behind an injectable seam so the
// hermetic gate (no agy on PATH) can stub it.
type AgyWhichProbe = () => boolean;
const defaultAgyWhich: AgyWhichProbe = () => Bun.which('agy') !== null;
let agyWhichProbe: AgyWhichProbe = defaultAgyWhich;

/** Override the agy PATH probe (tests only). Pass null to restore the default. */
export function setAgyWhichForTesting(probe: AgyWhichProbe | null): void {
  agyWhichProbe = probe ?? defaultAgyWhich;
}

// Stage a clean copy of the Superpowers plugin (sans eval output / cruft) into a
// fresh temp dir and return its path. The caller hands it to `agy plugin install`
// and removes it afterward (agy copies it into the gemini home at install time).
// agy `plugin install <path>` deep-copies the given path, so the eval output and
// VCS/build cruft that stageSuperpowersPlugin drops would otherwise explode it.
export function stageAntigravityPluginSource(superpowersRoot: string): string {
  const staged = mkdtempSync(join(tmpdir(), 'quorum-agy-plugin-'));
  stageSuperpowersPlugin(superpowersRoot, staged);
  return staged;
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

    // The superpowers root comes from the home spec: {mode:'root'} is staged
    // and installed as the plugin (step 3) and its files verified (step 4),
    // {mode:'none'} is the explicit stock arm and skips both steps, and an
    // undefined spec falls back to the ambient SUPERPOWERS_ROOT, whose absence
    // is a setup failure.
    const sp = resolveSuperpowersRoot(home);
    if (sp.kind === 'missing') {
      throw new ProvisionError(
        'SUPERPOWERS_ROOT not set; cannot install antigravity Superpowers plugin',
      );
    }
    // Fail fast with the precise diagnostic when agy is absent, before any work.
    if (!agyWhichProbe()) {
      throw new ProvisionError(
        'agy not found on PATH; cannot run antigravity evals',
      );
    }

    mkdirSync(configDir, { recursive: true });

    // 1. C1 OAuth-creds seed, BEFORE any agy subprocess (F13). With
    //    home_config_subdir ".", configDir IS the per-run throwaway home, so
    //    configDir/.gemini == $HOME/.gemini — exactly where agy reads its
    //    runtime credential (AGY_RUNTIME_OAUTH_TOKEN). The nested token is the
    //    credential agy actually reads; running any agy subprocess without it
    //    would leave agy reaching for the operator's per-login-user keyring —
    //    a host credential the eval must never touch — so a missing source
    //    token fails provisioning here, before the first subprocess.
    if (!seedAgyRuntimeToken(configDir)) {
      throw new ProvisionError(
        `agy runtime OAuth token missing at source: ${AGY_RUNTIME_OAUTH_TOKEN} ` +
          '(under AGY_OAUTH_HOME, else ~/.gemini). The per-run throwaway home ' +
          'must carry this token; a keyring-only host must seed it explicitly ' +
          'before running antigravity evals.',
      );
    }

    // 2. Auth preflight against throwaway state under the isolated run home.
    this.runAuthPreflight(runner, configDir);

    // 3. agy plugin install against the real per-run --gemini_dir, cwd =
    //    configDir, with auto-update disabled and HOME/config routing pinned
    //    to the isolated run home. Install from a CLEAN staged copy (sans
    //    evals/.git/node_modules) rather than the raw SUPERPOWERS_ROOT, so
    //    agy's deep-copy never recurses into nested eval output.
    // 4. Verify the required Superpowers plugin files landed. Both steps are
    //    superpowers staging — the none arm skips them.
    if (sp.kind === 'root') {
      const geminiDir = join(configDir, '.gemini');
      const stagedPlugin = stageAntigravityPluginSource(sp.root);
      let installResult: CommandResult;
      try {
        installResult = runner.run(
          'agy',
          [`--gemini_dir=${geminiDir}`, 'plugin', 'install', stagedPlugin],
          {
            cwd: configDir,
            env: antigravitySubprocessEnv(configDir),
          },
        );
      } finally {
        rmSync(stagedPlugin, { recursive: true, force: true });
      }
      if (installResult.status !== 0) {
        throw new ProvisionError(
          `agy plugin install failed (exit ${installResult.status}); stderr: ${installResult.stderr.trim().slice(0, 300)}`,
        );
      }

      const pluginRoot = join(geminiDir, 'config', 'plugins', 'superpowers');
      const missing = REQUIRED_PLUGIN_FILES.filter(
        (rel) => !existsSync(join(pluginRoot, rel)),
      );
      if (missing.length > 0) {
        throw new ProvisionError(
          `agy plugin install completed but expected Superpowers plugin files are missing: ${missing.join(', ')}`,
        );
      }
    }

    // 5. Persist no-prompt settings for the isolated run.
    writeAntigravitySettings(configDir, workdir);

    // NOTE: a pre-snapshot transcript assertion — the configDir transcripts must
    // be empty before the capture snapshot, else provisioning leaked a transcript
    // — belongs with the capture/runtime stage, not setup, and depends on the
    // capture snapshot machinery. Not handled here.

    // No extra env: agy finds its isolated state via the --gemini_dir flag the
    // launcher passes (= $QUORUM_AGENT_HOME/.gemini), not via an env var.
    return {};
  }

  // Validate the Gemini Code Assist backend with a throwaway --gemini_dir so
  // the real per-run .gemini stays pristine. The throwaway state lives UNDER
  // the isolated run home (never the shared OS tmpdir) and is discarded
  // afterward; the seeded per-run token is copied into it so that whichever
  // location agy resolves — its --gemini_dir tree or $HOME/.gemini via the
  // pinned HOME — it authenticates with the explicit per-run token, never the
  // operator keyring. The synchronous CommandRunner has no timeout knob, so
  // the live SpawnCommandRunner inherits the process default and the gate
  // stubs the call entirely. This is a one-shot --print invocation (not a
  // persistent/bidirectional process), so the synchronous seam models it
  // faithfully.
  private runAuthPreflight(runner: CommandRunner, configDir: string): void {
    const tmp = mkdtempSync(join(configDir, 'agy-preflight-'));
    try {
      const cwd = join(tmp, 'cwd');
      mkdirSync(cwd, { recursive: true });
      const geminiDir = join(tmp, '.gemini');
      const logPath = join(tmp, 'agy.log');

      // The run token was seeded before any agy subprocess (provision step 1);
      // mirror it into the throwaway tree at the same 0600.
      const runToken = join(configDir, '.gemini', AGY_RUNTIME_OAUTH_TOKEN);
      const preflightToken = join(geminiDir, AGY_RUNTIME_OAUTH_TOKEN);
      mkdirSync(dirname(preflightToken), { recursive: true });
      writeFileSync(preflightToken, readFileSync(runToken), { mode: 0o600 });
      chmodSync(preflightToken, 0o600);

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
          env: antigravitySubprocessEnv(configDir),
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
            `antigravity auth preflight failed (exit ${result.status}); the preflight runs under the isolated run home seeded with the explicit per-run token — check that ~/.gemini/antigravity-cli/antigravity-oauth-token (under AGY_OAUTH_HOME) is fresh and re-mint it with a local agy browser login if expired. stderr: ${result.stderr.trim().slice(0, 300)}`,
          );
        }
        throw new ProvisionError(
          `antigravity auth preflight did not return OK; stdout: ${result.stdout.trim().slice(0, 300)}`,
        );
      }

      // The real agy writes a transcript under the isolated --gemini_dir; its
      // presence proves the --gemini_dir isolation seam took effect (checked by
      // globbing <gemini_dir>/antigravity-cli/brain/**/transcript.jsonl).
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

// Persist no-prompt settings for the isolated Antigravity run. Parses any
// existing settings.json (boundary) rather than asserting its shape, merges the
// given workspace into trustedWorkspaces (idempotent), and pins the
// always-proceed permission posture. Called TWICE: once at provision time with
// the workdir, and again from the runner after launch-cwd resolution with the
// RESOLVED (possibly visible-aliased) launch cwd — so the agent trusts the actual
// workspace. Exported so the runner can perform that second write.
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

  // Default trustedWorkspaces to [], then append the run workdir in both its
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
  // 2-space indent, no trailing newline.
  writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
}

// Parse an existing settings.json into a plain object. A non-object payload is
// unusable as a settings map; surface it as a ProvisionError rather than silently
// discarding it.
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

// Normalize the auth-preflight reply tolerantly. The preflight asks agy to
// "Reply with EXACTLY OK." A compliant model occasionally appends punctuation or
// differs in case; strip trailing . and ! plus whitespace and uppercase, but
// still reject empty (rate-limited / dead) or verbose replies.
function preflightResponseOk(stdout: string): boolean {
  return rstripDotBang(stdout.trim()).trim().toUpperCase() === 'OK';
}

// Strip any trailing run of . or ! characters.
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
// agy log to <configDir>/agy.log. Scanning the log after the run yields the
// indeterminate VERDICT. Returns the reason string when rate-limited, else null.
//
// The live counterparts: AgyRateLimitWatcher (agy-watch.ts) tails the log mid-run
// and fires killRunTmuxServer (agy-teardown.ts) on the first signal for early
// teardown. A mid-run kill touches only the per-run seeded token inside the
// throwaway home — never any operator credential. This post-run scan is the
// verdict-layer signal.
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

// The preflight's transcript glob on an arbitrary gemini_dir: recursively
// collect **/transcript.jsonl under <geminiDir>/antigravity-cli/brain.
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

// True if any component of *path* is a dot-prefixed (hidden) directory. "." and
// ".." themselves are not hidden.
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
 * eval repo's git status / dirty-tree assertions. Exported for the runner.
 */
export function excludeAntigravityProjectMarker(
  launchCwd: string,
  probe: GitProbe = gitProbe,
): void {
  const inside = probe(launchCwd, ['rev-parse', '--is-inside-work-tree']);
  if (inside.status !== 0 || inside.stdout !== 'true') {
    return;
  }

  // A non-zero exit must raise rather than yield "" — an empty git-path collapses
  // excludePath to launchCwd, so the later writeFileSync would target a directory
  // (EISDIR) instead of failing cleanly here.
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
  // Drop the trailing-newline empty element for the membership/last-line checks.
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
 * the substitution under *runDir*. Exported for the runner.
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

// Expand a leading ~ to the user's home dir.
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
