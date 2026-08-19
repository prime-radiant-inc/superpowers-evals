// Per-job scoped credential material for the appliance (F13 filesystem half).
// One resolved CredentialScope is projected out of the blessed bundle into a
// fixed, private state namespace:
//
//   state/credentials-scoped/staging   — while a generation is being built
//   state/credentials-scoped/active    — the one active generation
//     active/agent.env                 — shell-single-quoted agent assignments
//     active/supervisor.exec.env       — Docker KEY=value lines (live only)
//     active/auth/<mount-name>/...     — exact projected OAuth material
//   state/credentials-scoped/recovery  — only during an interrupted swap
//
// Structural/credential split: recovery and read operations never touch the
// bundle; only the credential-aware staging paths here load and no-follow
// validate it. Every source file is projected through a validated
// regular-file read and a private destination write — never a recursive copy
// of a bundle directory — and staged material is 0700 dirs / 0600 files.
import { spawnSync } from 'node:child_process';
import {
  closeSync,
  constants as fsConstants,
  fstatSync,
  fsyncSync,
  lstatSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  type Stats,
  writeFileSync,
} from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import {
  APPLIANCE_SCOPED_GRADER_MODE,
  COPILOT_SUPERVISOR_ENV_NAMES,
  GRADER_AUTH_RUNTIME_NAMES,
  GRADER_SOURCE_ENV_BY_RUNTIME_NAME,
  QUORUM_GRADER_SOURCE_MODE,
  SUPERVISOR_NETWORK_ENV_NAMES,
} from '../credentials/grader.ts';
import {
  EMPTY_CREDENTIAL_SCOPE,
  type EmptyCredentialScope,
  type LiveCredentialScope,
} from '../credentials/scope.ts';
import { ApplianceError } from './errors.ts';
import {
  assertNoFollowDirChain,
  assertRealDirNoFollow,
  ensurePrivateDirNoFollow,
} from './safe-fs.ts';
import type { ApplianceConfig, LoadedApplianceConfig } from './types.ts';

export interface ProjectedAuthMount {
  readonly name: 'codex' | 'gemini' | 'kimi' | 'pi';
  readonly path: string;
}

export interface EmptyStagedCredentialMaterial {
  readonly kind: 'empty';
  readonly credentialScope: EmptyCredentialScope;
  readonly stageDir: string;
  readonly agentEnvFile: string;
  readonly supervisorExecEnvFile: null;
  readonly authMounts: readonly [];
}

export interface LiveStagedCredentialMaterial {
  readonly kind: 'live';
  readonly credentialScope: LiveCredentialScope;
  readonly stageDir: string;
  readonly agentEnvFile: string;
  readonly supervisorExecEnvFile: string;
  readonly authMounts: readonly ProjectedAuthMount[];
}

export type StagedCredentialMaterial =
  | EmptyStagedCredentialMaterial
  | LiveStagedCredentialMaterial;

export interface EmptyActiveCredentialMaterial {
  readonly kind: 'empty';
  readonly credentialScope: EmptyCredentialScope;
  readonly root: string;
  readonly agentEnvFile: string;
  readonly supervisorExecEnvFile: null;
  readonly authMounts: readonly [];
}

export interface LiveActiveCredentialMaterial {
  readonly kind: 'live';
  readonly credentialScope: LiveCredentialScope;
  readonly root: string;
  readonly agentEnvFile: string;
  readonly supervisorExecEnvFile: string;
  readonly authMounts: readonly ProjectedAuthMount[];
}

export type ActiveCredentialMaterial =
  | EmptyActiveCredentialMaterial
  | LiveActiveCredentialMaterial;

const AGENT_ENV_FILE = 'agent.env';
const SUPERVISOR_ENV_FILE = 'supervisor.exec.env';
const FIXED_SLOTS = ['staging', 'active', 'recovery'] as const;

interface ScopedPaths {
  readonly root: string;
  readonly staging: string;
  readonly active: string;
  readonly recovery: string;
}

function scopedPaths(config: ApplianceConfig): ScopedPaths {
  const root = join(config.root, 'state', 'credentials-scoped');
  return {
    root,
    staging: join(root, 'staging'),
    active: join(root, 'active'),
    recovery: join(root, 'recovery'),
  };
}

function scopeError(message: string): ApplianceError {
  return new ApplianceError('config_invalid', 'credential-scope', message);
}

function lstatOrUndefined(path: string, label: string): Stats | undefined {
  try {
    return lstatSync(path, { throwIfNoEntry: false });
  } catch (error) {
    throw scopeError(
      `${label} is unreadable (${(error as NodeJS.ErrnoException).code ?? 'unknown error'}): ${path}`,
    );
  }
}

// Canonical no-follow identity for boundary comparison. An EXISTING target
// must be a real directory reached without following a symlink — a
// symlink-aliased repo/results/bundle path is refused outright, so an alias
// can never dodge the overlap checks. A MISSING target canonicalizes through
// its nearest existing ancestor under the same no-follow rule. realpath then
// only normalizes case/`..`-free spelling (every component is already real),
// giving a canonical identity safe for lexical exact/ancestor/descendant
// comparison.
function canonicalBoundaryPath(path: string, label: string): string {
  const target = resolve(path);
  try {
    if (lstatOrUndefined(target, label) !== undefined) {
      assertRealDirNoFollow(target, label);
      return realpathSync(target);
    }
    let ancestor = dirname(target);
    while (lstatOrUndefined(ancestor, label) === undefined) {
      const parent = dirname(ancestor);
      if (parent === ancestor) {
        break;
      }
      ancestor = parent;
    }
    assertRealDirNoFollow(ancestor, label);
    return join(realpathSync(ancestor), relative(ancestor, target));
  } catch (error) {
    if (error instanceof ApplianceError) {
      throw error;
    }
    throw scopeError(
      `${label} could not be canonicalized (${(error as NodeJS.ErrnoException).code ?? 'unknown error'}): ${path}`,
    );
  }
}

function pathsOverlap(a: string, b: string): boolean {
  return a === b || a.startsWith(b + sep) || b.startsWith(a + sep);
}

function overlapTargets(config: ApplianceConfig): readonly [string, string][] {
  return [
    ['evals repo', config.evals.path],
    ['superpowers repo', config.superpowers.path],
    ['gauntlet repo', config.gauntlet.path],
    ['results root', config.container.results_root],
  ];
}

// The shared overlap engine for both boundaries: the subject and every
// comparison target are reduced to canonical no-follow identities first, and
// any exact/ancestor/descendant relation is a typed refusal.
function assertNoBoundaryOverlap(
  subjectLabel: string,
  subjectPath: string,
  targets: readonly [string, string][],
): void {
  const subject = canonicalBoundaryPath(subjectPath, subjectLabel);
  for (const [label, target] of targets) {
    if (pathsOverlap(subject, canonicalBoundaryPath(target, label))) {
      throw scopeError(
        `${subjectLabel} overlaps the ${label} (${target}); repair the appliance config`,
      );
    }
  }
}

// Every entry under a fixed slot must be a real directory or a regular file
// reached without following a symlink; anything else is content from outside
// the boundary wearing this generation's name.
function assertRegularTree(dir: string, label: string): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      assertRegularTree(path, label);
    } else if (!entry.isFile()) {
      throw scopeError(`${label} contains a non-regular entry: ${path}`);
    }
  }
}

/**
 * Validate the scoped credential state namespace: every existing component
 * no-follow, only the three fixed slots present, and no ancestor/descendant
 * overlap between state/credentials-scoped and the evals, superpowers, or
 * gauntlet repos, the results root, or the credential bundle (a bundle
 * overlapping this namespace would let staging cleanup remove blessed
 * material). All comparisons use canonical no-follow identities, and the
 * overlap checks run BEFORE any enumeration or cleanup. Probe staging calls
 * only this helper and never inspects blessed bundle contents (the bundle
 * path itself is compared at directory level only). Every exported mutator
 * over the namespace runs this boundary first.
 */
export function assertScopedCredentialStateBoundary(
  loaded: LoadedApplianceConfig,
): void {
  const config = loaded.config;
  const paths = scopedPaths(config);
  assertNoBoundaryOverlap('state/credentials-scoped', paths.root, [
    ...overlapTargets(config),
    ['credential bundle', config.credential_bundle.path],
  ]);
  if (
    !assertNoFollowDirChain(config.root, paths.root, 'state/credentials-scoped')
  ) {
    return;
  }
  const fixed = new Set<string>(FIXED_SLOTS);
  for (const entry of readdirSync(paths.root, { withFileTypes: true })) {
    if (!fixed.has(entry.name)) {
      throw scopeError(
        `unexpected entry '${entry.name}' in state/credentials-scoped; only staging/active/recovery may exist — repair manually`,
      );
    }
    if (entry.isSymbolicLink() || !entry.isDirectory()) {
      throw scopeError(
        `state/credentials-scoped/${entry.name} must be a real directory; repair manually`,
      );
    }
    assertRegularTree(
      join(paths.root, entry.name),
      `state/credentials-scoped/${entry.name}`,
    );
  }
}

/**
 * Validate the blessed bundle boundary: a real no-follow bundle directory
 * with no ancestor/descendant overlap against the code repos, results root,
 * or the scoped credential state namespace (symmetric with the state
 * boundary). Comparisons use canonical no-follow identities. Live staging
 * calls this (plus the state boundary) before any evaluation;
 * loadCredentialConfig calls it before reading metadata.json.
 */
export function assertCredentialBundleBoundary(config: ApplianceConfig): void {
  const bundleDir = config.credential_bundle.path;
  assertRealDirNoFollow(bundleDir, 'credential bundle');
  assertNoBoundaryOverlap('credential bundle', bundleDir, [
    ...overlapTargets(config),
    ['scoped credential state', scopedPaths(config).root],
  ]);
}

// fd-based no-follow open of one regular file. O_NOFOLLOW makes the kernel —
// not a racy lstat-then-open sequence — reject a symlink final component;
// O_NONBLOCK keeps a FIFO from blocking the open so fstat can refuse it; any
// other special node (socket, device) is refused by errno or by the fstat
// regular-file check. Every fs failure is normalized to a typed
// ApplianceError; raw errnos never escape.
function openNoFollowRegularFile(
  path: string,
  label: string,
  required: boolean,
): number | null {
  let fd: number;
  try {
    fd = openSync(
      path,
      fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK,
    );
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') {
      if (!required) {
        return null;
      }
      throw scopeError(`${label} is missing: ${path}`);
    }
    if (code === 'ELOOP' || code === 'EMLINK') {
      throw scopeError(`${label} is a symlink: ${path}`);
    }
    throw scopeError(
      `${label} is not a readable regular file (${code ?? 'unknown error'}): ${path}`,
    );
  }
  try {
    if (!fstatSync(fd).isFile()) {
      closeSync(fd);
      throw scopeError(`${label} is not a regular file: ${path}`);
    }
  } catch (error) {
    if (error instanceof ApplianceError) {
      throw error;
    }
    closeSync(fd);
    throw scopeError(
      `${label} could not be inspected (${(error as NodeJS.ErrnoException).code ?? 'unknown error'}): ${path}`,
    );
  }
  return fd;
}

// Validate the intermediate components of bundleDir/rel no-follow, then read
// the final component through an O_NOFOLLOW file descriptor. `required:
// false` treats a missing component as absence.
function readBundleFile(
  bundleDir: string,
  rel: string,
  required: boolean,
): string | null {
  const parts = rel.split('/');
  let cursor = bundleDir;
  for (let i = 0; i < parts.length - 1; i += 1) {
    cursor = join(cursor, parts[i] ?? '');
    const stats = lstatOrUndefined(cursor, 'credential bundle');
    if (stats === undefined) {
      if (!required) {
        return null;
      }
      throw scopeError(`credential bundle is missing ${rel}`);
    }
    if (stats.isSymbolicLink()) {
      throw scopeError(`credential bundle path is a symlink: ${cursor}`);
    }
    if (!stats.isDirectory()) {
      throw scopeError(`credential bundle path is not a directory: ${cursor}`);
    }
  }
  const final = join(cursor, parts[parts.length - 1] ?? '');
  const fd = openNoFollowRegularFile(
    final,
    `credential bundle ${rel}`,
    required,
  );
  if (fd === null) {
    return null;
  }
  try {
    return readFileSync(fd, 'utf8');
  } catch (error) {
    throw scopeError(
      `credential bundle ${rel} could not be read (${(error as NodeJS.ErrnoException).code ?? 'unknown error'}): ${final}`,
    );
  } finally {
    closeSync(fd);
  }
}

// Local no-follow private write into the staging slot. O_CREAT|O_EXCL|
// O_NOFOLLOW means a pre-planted entry (symlink or otherwise) at the
// destination is a typed refusal, never a follow — the slot was cleared
// first, so any EEXIST is hostile. fs failures never escape raw.
function writeScopedPrivateFile(path: string, value: string): void {
  let fd: number;
  try {
    fd = openSync(
      path,
      fsConstants.O_WRONLY |
        fsConstants.O_CREAT |
        fsConstants.O_EXCL |
        fsConstants.O_NOFOLLOW,
      0o600,
    );
  } catch (error) {
    throw scopeError(
      `scoped credential file could not be created (${(error as NodeJS.ErrnoException).code ?? 'unknown error'}): ${path}`,
    );
  }
  try {
    writeFileSync(fd, value);
    fsyncSync(fd);
  } catch (error) {
    throw scopeError(
      `scoped credential file could not be written (${(error as NodeJS.ErrnoException).code ?? 'unknown error'}): ${path}`,
    );
  } finally {
    closeSync(fd);
  }
}

// One isolated evaluation of the trusted bundle env: /bin/bash with no
// profile, no rc, and a minimal non-secret environment sources the
// already-read env bytes from ITS OWN STDIN — the path is never reopened, so
// the bytes bash evaluates are exactly the bytes the O_NOFOLLOW read
// validated — with allexport, and prints exactly the requested names
// NUL-separated. bash-3.2 compatible (macOS /bin/bash): ${!name+x} composes
// indirection with the set-test.
const BUNDLE_EVAL_SCRIPT = [
  'set -eu',
  'set -a',
  '. /dev/stdin',
  'set +a',
  'for name in "$@"; do',
  // biome-ignore lint/suspicious/noTemplateCurlyInString: bash indirect expansion, not a JS template
  '  if [ "${!name+x}" = x ]; then',
  // biome-ignore lint/suspicious/noTemplateCurlyInString: bash indirect expansion, not a JS template
  '    printf "%s=%s\\0" "$name" "${!name}"',
  '  fi',
  'done',
].join('\n');

function evaluateBundleEnv(
  envContent: string,
  names: readonly string[],
): Map<string, string> {
  const result = spawnSync(
    '/bin/bash',
    ['--noprofile', '--norc', '-c', BUNDLE_EVAL_SCRIPT, 'bundle-env', ...names],
    { env: { PATH: '/usr/bin:/bin' }, input: envContent, encoding: 'utf8' },
  );
  if (result.status !== 0) {
    // stderr is withheld deliberately: a hostile env file can steer bash
    // error text, and error messages must never carry bundle content.
    throw scopeError(
      `credentials.env evaluation failed (bash exit ${result.status ?? 'null'})`,
    );
  }
  const values = new Map<string, string>();
  for (const chunk of result.stdout.split('\0')) {
    if (chunk === '') {
      continue;
    }
    const eq = chunk.indexOf('=');
    if (eq <= 0) {
      continue;
    }
    values.set(chunk.slice(0, eq), chunk.slice(eq + 1));
  }
  return values;
}

// Single-quote a value for a POSIX shell, escaping embedded single quotes
// (the same idiom the copilot env-file writer uses).
function shellSingleQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

interface LabeledSecret {
  readonly label: string;
  readonly value: string;
}

interface AgentEnvSelection {
  readonly entries: readonly [string, string][];
  readonly secrets: readonly LabeledSecret[];
}

function selectAgentEnv(
  scope: LiveCredentialScope,
  bundleEnv: ReadonlyMap<string, string>,
): AgentEnvSelection {
  const entries: [string, string][] = [];
  const secrets: LabeledSecret[] = [];
  for (const projection of scope.agentEnv) {
    let selected: string | undefined;
    for (const source of projection.sourceNames) {
      const value = bundleEnv.get(source);
      if (value !== undefined && value !== '') {
        selected = value;
        break;
      }
    }
    if (selected === undefined) {
      throw scopeError(
        `trusted bundle provides no nonempty source for agent env '${projection.destinationName}' (sources: ${projection.sourceNames.join(', ')})`,
      );
    }
    entries.push([projection.destinationName, selected]);
    secrets.push({
      label: `agent env ${projection.destinationName}`,
      value: selected,
    });
  }
  if (scope.geminiAuthType !== null) {
    const bundleValue = bundleEnv.get('GEMINI_AUTH_TYPE');
    if (
      bundleValue !== undefined &&
      bundleValue !== '' &&
      bundleValue !== scope.geminiAuthType
    ) {
      throw scopeError(
        `trusted bundle GEMINI_AUTH_TYPE contradicts the credential scope's '${scope.geminiAuthType}'`,
      );
    }
    entries.push(['GEMINI_AUTH_TYPE', scope.geminiAuthType]);
  }
  return { entries, secrets };
}

interface SupervisorSelection {
  readonly lines: readonly string[];
  readonly graderAuthValues: readonly string[];
}

function buildSupervisorEnv(
  scope: LiveCredentialScope,
  bundleEnv: ReadonlyMap<string, string>,
): SupervisorSelection {
  const entries: [string, string][] = [
    [QUORUM_GRADER_SOURCE_MODE, APPLIANCE_SCOPED_GRADER_MODE],
  ];
  for (const alias of Object.values(GRADER_SOURCE_ENV_BY_RUNTIME_NAME)) {
    const value = bundleEnv.get(alias);
    if (value !== undefined) {
      entries.push([alias, value]);
    }
  }
  const graderAuthValues = GRADER_AUTH_RUNTIME_NAMES.map((name) =>
    bundleEnv.get(GRADER_SOURCE_ENV_BY_RUNTIME_NAME[name]),
  ).filter((value): value is string => value !== undefined && value !== '');
  if (graderAuthValues.length === 0) {
    throw scopeError(
      'trusted bundle provides no nonempty QUORUM_GRADER_* grader auth source (a base URL alone is not auth)',
    );
  }
  const routingNames: readonly string[] =
    scope.runtimeFamily === 'copilot'
      ? [...SUPERVISOR_NETWORK_ENV_NAMES, ...COPILOT_SUPERVISOR_ENV_NAMES]
      : [...SUPERVISOR_NETWORK_ENV_NAMES];
  for (const name of routingNames) {
    const value = bundleEnv.get(name);
    if (value !== undefined) {
      entries.push([name, value]);
    }
  }
  for (const [name, value] of entries) {
    // Docker --env-file values are line-delimited: an embedded CR or LF
    // would smuggle extra variables into the supervisor env.
    if (/[\r\n]/.test(value)) {
      throw scopeError(`supervisor env value for ${name} contains CR/LF`);
    }
  }
  return {
    lines: entries.map(([name, value]) => `${name}=${value}`),
    graderAuthValues,
  };
}

function jsonStringLeaves(raw: string, label: string): string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw scopeError(`${label} is not valid JSON`);
  }
  const leaves: string[] = [];
  const visit = (value: unknown): void => {
    if (typeof value === 'string') {
      if (value !== '') {
        leaves.push(value);
      }
    } else if (Array.isArray(value)) {
      for (const item of value) {
        visit(item);
      }
    } else if (typeof value === 'object' && value !== null) {
      for (const item of Object.values(value)) {
        visit(item);
      }
    }
  };
  visit(parsed);
  return leaves;
}

// Both spellings of a raw token file: the byte payload and its trimmed form.
// The comparison must catch a grader token however the file terminates.
function tokenSecrets(label: string, raw: string): LabeledSecret[] {
  const trimmed = raw.trim();
  const secrets: LabeledSecret[] = [{ label, value: raw }];
  if (trimmed !== raw) {
    secrets.push({ label, value: trimmed });
  }
  return secrets;
}

interface PlannedFile {
  // Path relative to auth/<mount-name>/ inside the stage.
  readonly rel: string;
  readonly content: string;
}

interface OAuthPlan {
  readonly mountName: ProjectedAuthMount['name'];
  readonly files: readonly PlannedFile[];
  readonly secrets: readonly LabeledSecret[];
}

// The closed runtime kind-to-mount table. TS types already pin these, but a
// cast or deserialized scope can violate them at runtime, and the mount name
// becomes a path component — so the mapping is re-validated here before any
// destination path is derived from it.
const OAUTH_MOUNT_BY_KIND: Readonly<
  Record<string, ProjectedAuthMount['name']>
> = {
  codex: 'codex',
  gemini: 'gemini',
  antigravity: 'gemini',
  kimi: 'kimi',
  pi: 'pi',
};

const PROJECTED_MOUNT_NAMES: ReadonlySet<ProjectedAuthMount['name']> = new Set([
  'codex',
  'gemini',
  'kimi',
  'pi',
]);

function requireProjectedMountName(
  name: ProjectedAuthMount['name'],
): ProjectedAuthMount['name'] {
  if (!PROJECTED_MOUNT_NAMES.has(name)) {
    throw scopeError(`unknown auth mount name '${String(name)}'`);
  }
  return name;
}

function planOAuth(
  scope: LiveCredentialScope,
  bundleDir: string,
): OAuthPlan | null {
  const oauth = scope.oauth;
  if (oauth === null) {
    return null;
  }
  const expectedMount = Object.hasOwn(OAUTH_MOUNT_BY_KIND, oauth.kind)
    ? OAUTH_MOUNT_BY_KIND[oauth.kind]
    : undefined;
  if (expectedMount === undefined) {
    throw scopeError(
      `unknown oauth projection kind '${(oauth as { kind: string }).kind}'`,
    );
  }
  if (oauth.mountName !== expectedMount) {
    throw scopeError(
      `oauth kind '${oauth.kind}' must use mount '${expectedMount}', got '${String(oauth.mountName)}'`,
    );
  }
  switch (oauth.kind) {
    case 'codex': {
      const raw = readBundleFile(bundleDir, 'codex/auth.json', true) ?? '';
      return {
        mountName: oauth.mountName,
        files: [{ rel: 'auth.json', content: raw }],
        secrets: jsonStringLeaves(raw, 'codex auth.json').map((value) => ({
          label: 'codex auth.json',
          value,
        })),
      };
    }
    case 'gemini': {
      const creds =
        readBundleFile(bundleDir, 'gemini/oauth_creds.json', true) ?? '';
      const accounts =
        readBundleFile(bundleDir, 'gemini/google_accounts.json', true) ?? '';
      return {
        mountName: oauth.mountName,
        files: [
          { rel: 'oauth_creds.json', content: creds },
          { rel: 'google_accounts.json', content: accounts },
        ],
        secrets: [
          ...jsonStringLeaves(creds, 'gemini oauth_creds.json').map(
            (value) => ({
              label: 'gemini oauth_creds.json',
              value,
            }),
          ),
          ...jsonStringLeaves(accounts, 'gemini google_accounts.json').map(
            (value) => ({ label: 'gemini google_accounts.json', value }),
          ),
        ],
      };
    }
    case 'antigravity': {
      const rel = 'antigravity-cli/antigravity-oauth-token';
      const raw = readBundleFile(bundleDir, `gemini/${rel}`, true) ?? '';
      return {
        mountName: oauth.mountName,
        files: [{ rel, content: raw }],
        secrets: tokenSecrets('antigravity oauth token', raw),
      };
    }
    case 'kimi': {
      const config =
        readBundleFile(bundleDir, 'kimi-code/config.toml', true) ?? '';
      const creds =
        readBundleFile(
          bundleDir,
          'kimi-code/credentials/kimi-code.json',
          true,
        ) ?? '';
      const oauthToken = readBundleFile(
        bundleDir,
        'kimi-code/oauth/kimi-code',
        false,
      );
      const files: PlannedFile[] = [
        // config.toml carries non-credential model/endpoint fields; it is
        // projected but excluded from the secret-equality comparison.
        { rel: 'config.toml', content: config },
        { rel: 'credentials/kimi-code.json', content: creds },
      ];
      const secrets: LabeledSecret[] = jsonStringLeaves(
        creds,
        'kimi credentials',
      ).map((value) => ({ label: 'kimi credentials', value }));
      if (oauthToken !== null) {
        files.push({ rel: 'oauth/kimi-code', content: oauthToken });
        secrets.push(...tokenSecrets('kimi oauth token', oauthToken));
      }
      return { mountName: oauth.mountName, files, secrets };
    }
    case 'pi': {
      const raw = readBundleFile(bundleDir, 'pi/agent/auth.json', true) ?? '';
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        throw scopeError('pi agent auth.json is not valid JSON');
      }
      if (
        typeof parsed !== 'object' ||
        parsed === null ||
        Array.isArray(parsed)
      ) {
        throw scopeError(
          'pi agent auth.json is not a flat provider-keyed record',
        );
      }
      // Own-property selection only: inherited Object.prototype names are
      // never provider entries.
      if (!Object.hasOwn(parsed, oauth.provider)) {
        throw scopeError(
          `pi agent auth.json has no entry for provider '${oauth.provider}'`,
        );
      }
      const entry = (parsed as Record<string, unknown>)[oauth.provider];
      const content = JSON.stringify({ [oauth.provider]: entry });
      return {
        mountName: oauth.mountName,
        // settings.json is deliberately not projected: the provider is
        // explicit in the scope.
        files: [{ rel: 'agent/auth.json', content }],
        secrets: jsonStringLeaves(content, 'pi provider entry').map(
          (value) => ({
            label: `pi provider ${oauth.provider}`,
            value,
          }),
        ),
      };
    }
    default: {
      // Runtime-exhaustive: a cast unknown kind fails closed.
      throw scopeError(
        `unknown oauth projection kind '${(oauth as { kind: string }).kind}'`,
      );
    }
  }
}

// All-pairs distinctness between the agent's delivered secret material and
// every nonempty grader auth value: any equality fails closed, even across
// differently named channels. Values are never logged, hashed, serialized,
// or included in the error — only the channel labels are.
function assertDistinctFromGraderAuth(
  agentSecrets: readonly LabeledSecret[],
  graderAuthValues: readonly string[],
): void {
  for (const secret of agentSecrets) {
    for (const graderValue of graderAuthValues) {
      if (secret.value === graderValue) {
        throw scopeError(
          `agent credential material (${secret.label}) equals a grader auth value; the blessed bundle must keep agent and grader credentials distinct`,
        );
      }
    }
  }
}

// Clear ONLY the fixed staging slot, validating its chain no-follow first.
// Never touches active or recovery, so an interrupted stage is safely
// recovered on the next invocation without risking the live generation.
function clearStagingSlot(loaded: LoadedApplianceConfig): void {
  const paths = scopedPaths(loaded.config);
  if (
    assertNoFollowDirChain(
      loaded.config.root,
      paths.staging,
      'state/credentials-scoped/staging',
    )
  ) {
    try {
      rmSync(paths.staging, { recursive: true });
    } catch (error) {
      throw scopeError(
        `the staging slot could not be cleared (${error instanceof Error ? error.message : String(error)}): ${paths.staging}`,
      );
    }
  }
}

function agentEnvBody(entries: readonly [string, string][]): string {
  return entries
    .map(([name, value]) => `${name}=${shellSingleQuote(value)}\n`)
    .join('');
}

/**
 * Stage the zero-material probe generation: an empty agent.env, no
 * supervisor env, no auth mounts. Calls only the scoped state boundary and
 * never inspects the blessed bundle.
 */
export function stageProbeCredentialMaterial(
  loaded: LoadedApplianceConfig,
): EmptyStagedCredentialMaterial {
  assertScopedCredentialStateBoundary(loaded);
  clearStagingSlot(loaded);
  const paths = scopedPaths(loaded.config);
  ensurePrivateDirNoFollow(
    loaded.config.root,
    paths.staging,
    'state/credentials-scoped/staging',
  );
  const agentEnvFile = join(paths.staging, AGENT_ENV_FILE);
  writeScopedPrivateFile(agentEnvFile, '');
  return {
    kind: 'empty',
    credentialScope: EMPTY_CREDENTIAL_SCOPE,
    stageDir: paths.staging,
    agentEnvFile,
    supervisorExecEnvFile: null,
    authMounts: [],
  };
}

/**
 * Stage one live generation for the given scope. Both boundary helpers run
 * first; every bundle fault is typed before shell evaluation or any staging
 * file exists; a partial failure clears the fixed staging slot best-effort.
 */
export function stageLiveCredentialMaterial(
  loaded: LoadedApplianceConfig,
  scope: LiveCredentialScope,
): LiveStagedCredentialMaterial {
  assertScopedCredentialStateBoundary(loaded);
  assertCredentialBundleBoundary(loaded.config);
  clearStagingSlot(loaded);

  const bundleDir = loaded.config.credential_bundle.path;
  const paths = scopedPaths(loaded.config);

  // Read and validate every credential source BEFORE creating the stage, so
  // a bundle fault can never leave partial secret material behind. The env
  // bytes are read once through the O_NOFOLLOW descriptor and handed to bash
  // via stdin — the path is never reopened.
  const oauthPlan = planOAuth(scope, bundleDir);
  const envContent = readBundleFile(bundleDir, 'credentials.env', true);
  if (envContent === null) {
    throw scopeError('credential bundle is missing credentials.env');
  }
  const names = new Set<string>();
  for (const projection of scope.agentEnv) {
    for (const source of projection.sourceNames) {
      names.add(source);
    }
  }
  names.add('GEMINI_AUTH_TYPE');
  for (const alias of Object.values(GRADER_SOURCE_ENV_BY_RUNTIME_NAME)) {
    names.add(alias);
  }
  for (const name of SUPERVISOR_NETWORK_ENV_NAMES) {
    names.add(name);
  }
  for (const name of COPILOT_SUPERVISOR_ENV_NAMES) {
    names.add(name);
  }
  const bundleEnv = evaluateBundleEnv(envContent, [...names]);

  const agent = selectAgentEnv(scope, bundleEnv);
  const supervisor = buildSupervisorEnv(scope, bundleEnv);
  assertDistinctFromGraderAuth(
    [...agent.secrets, ...(oauthPlan?.secrets ?? [])],
    supervisor.graderAuthValues,
  );

  // Every destination is constrained to the fixed staging slot before it is
  // used: a hostile mount name or relative path can never place material
  // outside the slot.
  const stagingRoot = resolve(paths.staging);
  const insideStaging = (dest: string): string => {
    const resolved = resolve(dest);
    if (resolved !== stagingRoot && !resolved.startsWith(stagingRoot + sep)) {
      throw scopeError(
        `staging destination escapes the fixed staging slot: ${dest}`,
      );
    }
    return resolved;
  };

  const agentEnvFile = insideStaging(join(paths.staging, AGENT_ENV_FILE));
  const supervisorExecEnvFile = insideStaging(
    join(paths.staging, SUPERVISOR_ENV_FILE),
  );
  const authMounts: ProjectedAuthMount[] = [];
  try {
    ensurePrivateDirNoFollow(
      loaded.config.root,
      paths.staging,
      'state/credentials-scoped/staging',
    );
    writeScopedPrivateFile(agentEnvFile, agentEnvBody(agent.entries));
    writeScopedPrivateFile(
      supervisorExecEnvFile,
      `${supervisor.lines.join('\n')}\n`,
    );
    if (oauthPlan !== null) {
      const mountRoot = insideStaging(
        join(paths.staging, 'auth', oauthPlan.mountName),
      );
      for (const file of oauthPlan.files) {
        const dest = insideStaging(join(mountRoot, file.rel));
        ensurePrivateDirNoFollow(
          loaded.config.root,
          dirname(dest),
          'state/credentials-scoped/staging',
        );
        writeScopedPrivateFile(dest, file.content);
      }
      authMounts.push({ name: oauthPlan.mountName, path: mountRoot });
    }
  } catch (error) {
    try {
      rmSync(paths.staging, { recursive: true, force: true });
    } catch {}
    if (error instanceof ApplianceError) {
      throw error;
    }
    // Never let a raw fs error escape the staging write phase.
    throw scopeError(
      `staging failed (${error instanceof Error ? error.message : String(error)})`,
    );
  }
  return {
    kind: 'live',
    credentialScope: scope,
    stageDir: paths.staging,
    agentEnvFile,
    supervisorExecEnvFile,
    authMounts,
  };
}

function requireRegularFile(path: string, label: string): void {
  const stats = lstatSync(path, { throwIfNoEntry: false });
  if (stats === undefined || !stats.isFile()) {
    throw scopeError(`${label} is missing or not a regular file: ${path}`);
  }
}

function slotExists(
  loaded: LoadedApplianceConfig,
  slot: string,
  label: string,
): boolean {
  return assertNoFollowDirChain(loaded.config.root, slot, label);
}

/**
 * Swap the complete stage into the fixed active slot. Called only after the
 * previous container is confirmed down. Activation never renames over a
 * nonempty directory: an existing active generation moves to the one fixed
 * recovery slot first, then the stage moves to the now-absent active path,
 * then the recovery slot is removed. A second-rename failure restores the
 * old active tree before the error returns.
 */
export function activateScopedCredentialMaterial(
  loaded: LoadedApplianceConfig,
  staged: StagedCredentialMaterial,
): ActiveCredentialMaterial {
  assertScopedCredentialStateBoundary(loaded);
  const paths = scopedPaths(loaded.config);
  if (staged.stageDir !== paths.staging) {
    throw scopeError(
      `staged material does not point at the fixed staging slot: ${staged.stageDir}`,
    );
  }
  if (!slotExists(loaded, paths.staging, 'state/credentials-scoped/staging')) {
    throw scopeError('no staged generation exists to activate');
  }
  requireRegularFile(join(paths.staging, AGENT_ENV_FILE), 'staged agent env');
  if (staged.kind === 'live') {
    requireRegularFile(
      join(paths.staging, SUPERVISOR_ENV_FILE),
      'staged supervisor env',
    );
  }
  if (slotExists(loaded, paths.recovery, 'state/credentials-scoped/recovery')) {
    throw scopeError(
      'an interrupted activation left the recovery slot; recover before activating a new generation',
    );
  }
  const activeExists = slotExists(
    loaded,
    paths.active,
    'state/credentials-scoped/active',
  );
  if (activeExists) {
    try {
      renameSync(paths.active, paths.recovery);
    } catch (error) {
      throw scopeError(
        `activation failed while retiring the active generation: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  try {
    renameSync(paths.staging, paths.active);
  } catch (error) {
    const swapMessage = error instanceof Error ? error.message : String(error);
    if (activeExists) {
      // Restore the old generation before surfacing the error; the stage
      // stays in its slot for a retry. If the restore ITSELF fails, the
      // original failure must not mask it: the previous generation is
      // stranded in the recovery slot with no active generation, and only a
      // rollback-failed error naming that state is honest.
      try {
        renameSync(paths.recovery, paths.active);
      } catch (restoreError) {
        throw scopeError(
          `activation rollback failed: the previous generation remains in state/credentials-scoped/recovery and no active generation exists (restore error: ${restoreError instanceof Error ? restoreError.message : String(restoreError)}); original swap failure: ${swapMessage} — run the interrupted-swap recovery after repairing`,
        );
      }
    }
    throw scopeError(
      `activation failed while swapping the stage into place: ${swapMessage}`,
    );
  }
  if (activeExists) {
    try {
      rmSync(paths.recovery, { recursive: true, force: true });
    } catch (error) {
      throw scopeError(
        `activation succeeded but the retired generation could not be removed from the recovery slot (${error instanceof Error ? error.message : String(error)}); repair state/credentials-scoped manually`,
      );
    }
  }

  // The returned material is derived ONLY from the fixed slot constants and
  // runtime-validated mount names — never by rebasing caller-provided paths.
  if (staged.kind === 'empty') {
    return {
      kind: 'empty',
      credentialScope: staged.credentialScope,
      root: paths.active,
      agentEnvFile: join(paths.active, AGENT_ENV_FILE),
      supervisorExecEnvFile: null,
      authMounts: [],
    };
  }
  return {
    kind: 'live',
    credentialScope: staged.credentialScope,
    root: paths.active,
    agentEnvFile: join(paths.active, AGENT_ENV_FILE),
    supervisorExecEnvFile: join(paths.active, SUPERVISOR_ENV_FILE),
    authMounts: staged.authMounts.map((mount) => ({
      name: requireProjectedMountName(mount.name),
      path: join(paths.active, 'auth', mount.name),
    })),
  };
}

/**
 * Remove only the fixed staging slot (validated no-follow, behind the
 * authoritative boundary). Never touches the active generation or the
 * recovery slot.
 */
export function discardStagedCredentialMaterial(
  loaded: LoadedApplianceConfig,
): void {
  assertScopedCredentialStateBoundary(loaded);
  clearStagingSlot(loaded);
}

/**
 * Resolve an interrupted active swap. May run only from
 * reconcileScopedContainer after the configured container is confirmed down.
 * recovery-without-active restores the old generation deterministically;
 * recovery-plus-active is ambiguous (two complete generations) and fails
 * closed; no recovery slot is a no-op. Runs the authoritative boundary
 * first, like every mutator over the namespace.
 */
export function recoverScopedCredentialActivation(
  loaded: LoadedApplianceConfig,
): void {
  assertScopedCredentialStateBoundary(loaded);
  const paths = scopedPaths(loaded.config);
  const recoveryExists = slotExists(
    loaded,
    paths.recovery,
    'state/credentials-scoped/recovery',
  );
  if (!recoveryExists) {
    return;
  }
  if (slotExists(loaded, paths.active, 'state/credentials-scoped/active')) {
    throw scopeError(
      'both active and recovery generations exist; refusing to guess between two complete generations — repair state/credentials-scoped manually',
    );
  }
  try {
    renameSync(paths.recovery, paths.active);
  } catch (error) {
    throw scopeError(
      `interrupted-swap recovery failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/**
 * Retire every scoped credential slot (staging, recovery, active), behind
 * the authoritative boundary and each validated no-follow before removal.
 * Leaves nothing to accumulate.
 */
export function retireScopedCredentialMaterial(
  loaded: LoadedApplianceConfig,
): void {
  assertScopedCredentialStateBoundary(loaded);
  const paths = scopedPaths(loaded.config);
  const slots: readonly [string, string][] = [
    [paths.staging, 'state/credentials-scoped/staging'],
    [paths.recovery, 'state/credentials-scoped/recovery'],
    [paths.active, 'state/credentials-scoped/active'],
  ];
  for (const [slot, label] of slots) {
    if (slotExists(loaded, slot, label)) {
      try {
        rmSync(slot, { recursive: true });
      } catch (error) {
        throw scopeError(
          `${label} could not be retired (${error instanceof Error ? error.message : String(error)})`,
        );
      }
    }
  }
}
