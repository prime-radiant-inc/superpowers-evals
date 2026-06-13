import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { AgentConfig } from '../contracts/agent-config.ts';
import { envSnapshot, getEnv } from '../env.ts';
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

// Substrings agy writes to its log/stderr when Code Assist throttles.
// RESOURCE_EXHAUSTED is the definitive 429 signal; ratelimitexceeded
// corroborates. Matched case-insensitively. Mirrors
// _AGY_RATE_LIMIT_SUBSTRINGS.
const AGY_RATE_LIMIT_SUBSTRINGS = ['resource_exhausted', 'ratelimitexceeded'];

// A word-boundaried HTTP-status 429. A bare 429 matches hex trace IDs, ports,
// and byte counts that pepper agy's streaming log; requiring a boundary avoids
// false trips. Mirrors _AGY_429_RE.
const AGY_429_RE = /\b429\b/;

// The plugin files agy plugin install must produce under
// .gemini/config/plugins/superpowers/ (mirrors the `required` list in
// _seed_antigravity_config). Relative to the plugin root.
const REQUIRED_PLUGIN_FILES: readonly string[] = [
  'plugin.json',
  'hooks.json',
  join('skills', 'using-superpowers', 'SKILL.md'),
];

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
    // The Python additionally guards `shutil.which("agy") is None`. We drive agy
    // through the injected runner instead of resolving it on PATH, so the seam
    // (and the real SpawnCommandRunner) surfaces a missing binary as a non-zero
    // / null status that the call sites below convert to a ProvisionError.

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
// rather than asserting its shape, merges trustedWorkspaces, and pins the
// always-proceed permission posture.
function writeAntigravitySettings(configDir: string, workdir: string): void {
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

// Port of _agy_log_shows_rate_limit: join the candidate texts, lowercase, and
// look for an unambiguous Code Assist throttle signal.
export function agyLogShowsRateLimit(...texts: string[]): boolean {
  const blob = texts
    .filter((t) => t !== '')
    .join('\n')
    .toLowerCase();
  if (AGY_RATE_LIMIT_SUBSTRINGS.some((sig) => blob.includes(sig))) {
    return true;
  }
  return AGY_429_RE.test(blob);
}

// Post-run rate-limit detection for the verdict layer. quorum writes the run's
// agy log to <configDir>/agy.log (parity with quorum/runner.py). spawnSync
// blocks, so the live AgyRateLimitWatcher's early tmux teardown is deferred
// (live-efficiency only); scanning the log after the run yields the same
// indeterminate VERDICT. Returns the reason string when rate-limited, else null.
// NOTE (live validation): confirm the gauntlet antigravity launcher routes the
// run's agy log to <configDir>/agy.log; the early-teardown watcher and OAuth
// creds restore / tmux reap remain B3/live work.
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
