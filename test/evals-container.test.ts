import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const REPO = resolve(import.meta.dir, '..');
const WRAPPER = join(REPO, 'scripts', 'evals-container');
const FAKE_CONTAINER_ID =
  'deadbeef0123456789abcdef0123456789abcdef0123456789abcdef01234567';

const FAKE_DOCKER = `#!/usr/bin/env bash
set -euo pipefail

python3 -c 'import json,sys; print(json.dumps(sys.argv[1:]))' "$@" >> "$EVALS_CONTAINER_DOCKER_LOG"

state_file="\${EVALS_CONTAINER_DOCKER_STATE:?}"
exists=false
running=false
name=
id=

if [[ -f "$state_file" ]]; then
  # shellcheck disable=SC1090
  source "$state_file"
fi

write_state() {
  {
    printf 'exists=%q\\n' "$exists"
    printf 'running=%q\\n' "$running"
    printf 'name=%q\\n' "$name"
    printf 'id=%q\\n' "$id"
  } > "$state_file"
}

case "$1" in
  build)
    exit 0
    ;;
  exec)
    if [[ "\${EVALS_CONTAINER_RESULTS_PROBE_FAIL:-}" == true && "\${3:-}" == "bash" && "\${4:-}" == "-lc" && "\${5:-}" == *"/workspace/evals/results"* ]]; then
      exit 1
    fi
    if [[ "\${3:-}" == "bash" && "\${4:-}" == "-lc" && "\${5:-}" == *": >"* && "\${5:-}" =~ (\\.evals-container-probe\\.[A-Za-z0-9._-]+) ]]; then
      probe_name="\${BASH_REMATCH[1]}"
      if [[ "\${EVALS_CONTAINER_RESULTS_HOST_VISIBLE_FAIL:-}" != true && -n "\${EVALS_CONTAINER_FAKE_RESULTS_HOST_DIR:-}" ]]; then
        mkdir -p "$EVALS_CONTAINER_FAKE_RESULTS_HOST_DIR"
        : > "$EVALS_CONTAINER_FAKE_RESULTS_HOST_DIR/$probe_name"
      fi
    fi
    exit 0
    ;;
  ps)
    if [[ "$exists" == true && "$running" == true && -n "$name" ]]; then
      printf '%s\\n' "$name"
    fi
    exit 0
    ;;
  container)
    if [[ "\${2:-}" != "inspect" ]]; then
      exit 1
    fi

    if [[ "$exists" != true ]]; then
      exit 1
    fi

    if [[ "\${3:-}" == "-f" ]]; then
      if [[ "\${5:-}" != "$name" ]]; then
        exit 1
      fi
      if [[ "\${4:-}" == "{{.State.Running}}" ]]; then
        printf '%s\\n' "$running"
      fi
      if [[ "\${4:-}" == "{{.Id}}" ]]; then
        printf '%s\\n' "$id"
      fi
      exit 0
    fi

    [[ "\${3:-}" == "$name" ]]
    ;;
  inspect)
    printf 'generic inspect is not supported by this fake docker\\n' >&2
    exit 2
    ;;
  run)
    # Faithful to real docker run: "$1" here is the fake-Docker
    # subcommand itself, so the positional arguments start at index 2 and
    # the FIRST non-flag token after the known value-taking options
    # (--name, --cidfile, --user, --workdir, --env, --mount, plus their =
    # forms) is the image; everything after the image is the container
    # command. An option-position-blind scan would let a misplaced option
    # pass here while real docker treats it as part of the container
    # command instead.
    shift
    name=""
    cidfile=""
    expect_value=""
    image_seen=false
    for arg in "$@"; do
      if [[ "$image_seen" == true ]]; then
        continue
      fi
      if [[ -n "$expect_value" ]]; then
        case "$arg" in
          -*) ;;
          *)
            case "$expect_value" in
              name) name="$arg" ;;
              cidfile) cidfile="$arg" ;;
            esac
            expect_value=""
            ;;
        esac
        continue
      fi
      case "$arg" in
        --name) expect_value=name ;;
        --name=*) name="\${arg#--name=}" ;;
        --cidfile) expect_value=cidfile ;;
        --cidfile=*) cidfile="\${arg#--cidfile=}" ;;
        --user|--workdir|--env|--mount) expect_value=skip ;;
        --user=*|--workdir=*|--env=*|--mount=*) ;;
        -*) ;;
        *) image_seen=true ;;
      esac
    done
    if [[ -z "$name" || "$name" == -* ]]; then
      exit 1
    fi
    exists=true
    running=true
    id="\${EVALS_CONTAINER_FAKE_CONTAINER_ID:?}"
    write_state
    if [[ -n "$cidfile" ]]; then
      printf '%s\\n' "$id" > "$cidfile"
    fi
    # Real docker run -d prints the new container's full id on stdout; the
    # knob models a docker/wrapper contract that misbehaves.
    case "\${EVALS_CONTAINER_RUN_STDOUT:-id}" in
      id) printf '%s\\n' "$id" ;;
      blank) : ;;
      multi) printf '%s %s\\n' "$id" "second-token" ;;
      name) printf '%s\\n' "evals-fake-container" ;;
      mismatch)
        printf '%s\\n' "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
        ;;
    esac
    exit 0
    ;;
  start)
    if [[ "$exists" != true || "\${2:-}" != "$name" ]]; then
      exit 1
    fi
    running=true
    write_state
    exit 0
    ;;
  stop)
    if [[ "$exists" != true || "\${2:-}" != "$name" ]]; then
      exit 1
    fi
    running=false
    write_state
    exit 0
    ;;
  rm)
    if [[ "\${EVALS_CONTAINER_RM_FAIL:-}" == true ]]; then
      exit 1
    fi
    shift
    if [[ "\${1:-}" == "-f" ]]; then
      shift
    fi
    if [[ "$exists" != true ]]; then
      exit 1
    fi
    if [[ "\${1:-}" != "$name" && "\${1:-}" != "$id" ]]; then
      exit 1
    fi
    exists=false
    running=false
    write_state
    exit 0
    ;;
  *)
    exit 1
    ;;
esac
`;

function makeHarness(extraEnv: NodeJS.ProcessEnv = {}): {
  root: string;
  dockerLog: string;
  dockerState: string;
  gauntletRoot: string;
  env: NodeJS.ProcessEnv;
} {
  const root = mkdtempSync(join(tmpdir(), 'evals-container-'));
  const bin = join(root, 'bin');
  mkdirSync(bin);
  const docker = join(bin, 'docker');
  const dockerLog = join(root, 'docker.log');
  const dockerState = join(root, 'docker-state');
  const gauntletRoot = join(root, 'gauntlet');
  mkdirSync(gauntletRoot);
  writeFileSync(join(gauntletRoot, 'package.json'), '{"name":"gauntlet"}\n');
  writeFileSync(docker, FAKE_DOCKER);
  chmodSync(docker, 0o755);

  return {
    root,
    dockerLog,
    dockerState,
    gauntletRoot,
    env: {
      ...Bun.env,
      ...extraEnv,
      EVALS_CONTAINER_DOCKER_LOG: dockerLog,
      EVALS_CONTAINER_DOCKER_STATE: dockerState,
      EVALS_CONTAINER_FAKE_CONTAINER_ID: FAKE_CONTAINER_ID,
      EVALS_CONTAINER_FAKE_RESULTS_HOST_DIR: join(REPO, 'results'),
      GAUNTLET_ROOT: gauntletRoot,
      PATH: `${bin}:${Bun.env['PATH'] ?? ''}`,
    },
  };
}

function writeDockerState(
  harness: ReturnType<typeof makeHarness>,
  state: { exists: boolean; running: boolean; name: string; id?: string },
): void {
  writeFileSync(
    harness.dockerState,
    [
      `exists=${state.exists ? 'true' : 'false'}`,
      `running=${state.running ? 'true' : 'false'}`,
      `name=${state.name}`,
      `id=${state.id ?? ''}`,
      '',
    ].join('\n'),
  );
}

function runWrapper(
  harness: ReturnType<typeof makeHarness>,
  args: string[],
  options: { cwd?: string } = {},
): ReturnType<typeof spawnSync> {
  return spawnSync(WRAPPER, args, {
    cwd: options.cwd,
    env: harness.env,
    encoding: 'utf8',
  });
}

function dockerLogLines(path: string): string[] {
  try {
    return readFileSync(path, 'utf8')
      .split('\n')
      .filter((line) => line.length > 0);
  } catch {
    return [];
  }
}

function dockerCommands(path: string): string[][] {
  return dockerLogLines(path).map((line) => JSON.parse(line) as string[]);
}

function dockerCommand(path: string, command: string): string[] {
  const found = dockerCommands(path).find((args) => args[0] === command);
  expect(found).toBeDefined();
  return found ?? [];
}

function dockerCommandsNamed(path: string, command: string): string[][] {
  return dockerCommands(path).filter((args) => args[0] === command);
}

function expectNoGenericInspect(path: string): void {
  expect(dockerCommandsNamed(path, 'inspect')).toEqual([]);
}

function mountArgs(args: string[]): string[] {
  const mounts: string[] = [];
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '--mount') {
      mounts.push(args[i + 1] ?? '');
    } else if (arg?.startsWith('--mount=')) {
      mounts.push(arg.slice('--mount='.length));
    }
  }
  return mounts;
}

function mountForTarget(args: string[], target: string): string {
  const found = mountArgs(args).find((mount) =>
    mount.split(',').some((part) => part === `target=${target}`),
  );
  expect(found).toBeDefined();
  return found ?? '';
}

function expectMountSource(mount: string, source: string): void {
  const expectedSource = realpathSync(source);
  const hasSource = mount
    .split(',')
    .some(
      (part) =>
        part === `source=${expectedSource}` || part === `src=${expectedSource}`,
    );
  expect(hasSource).toBe(true);
}

function expectReadonly(mount: string): void {
  expect(mount.split(',').some((part) => part.includes('readonly'))).toBe(true);
}

function envValue(args: string[], name: string): string | undefined {
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '--env') {
      const value = args[i + 1];
      if (value?.startsWith(`${name}=`)) {
        return value.slice(name.length + 1);
      }
    } else if (arg?.startsWith(`--env=${name}=`)) {
      return arg.slice(`--env=${name}=`.length);
    }
  }
}

function expectDockerfileArg(dockerfile: string | undefined): void {
  expect(dockerfile).toBeDefined();
  expect(resolve(REPO, dockerfile ?? '')).toBe(
    join(REPO, 'container', 'Dockerfile'),
  );
}

function writeEnvFile(root: string): string {
  const envFile = join(root, 'credentials.env');
  writeFileSync(envFile, 'OPENAI_API_KEY=sk-test\n');
  return envFile;
}

function makeSuperpowersRoot(root: string): string {
  const superpowersRoot = join(root, 'superpowers');
  mkdirSync(superpowersRoot);
  return superpowersRoot;
}

function gitInit(dir: string): void {
  spawnSync('git', ['init', '-q', dir]);
  spawnSync(
    'git',
    [
      '-C',
      dir,
      '-c',
      'user.email=t@t',
      '-c',
      'user.name=t',
      'commit',
      '--allow-empty',
      '-qm',
      'x',
    ],
    { cwd: dir },
  );
}

function gitRevParseHead(dir: string): string {
  const p = spawnSync('git', ['-C', dir, 'rev-parse', 'HEAD'], {
    encoding: 'utf8',
  });
  return (p.stdout ?? '').trim();
}

// A real superpowers root: a git repo with one commit, standing in for a
// normal (non-worktree) checkout.
function makeGitSuperpowersRoot(root: string): string {
  const superpowersRoot = join(root, 'superpowers');
  mkdirSync(superpowersRoot);
  gitInit(superpowersRoot);
  return superpowersRoot;
}

// A primary repo plus a linked worktree cut from it (`git worktree add`),
// standing in for a `cp-arm-*` campaign fixture (PRI-2494 item 22). Unlike
// the provenance.ts unit test, this does not need to hide the primary
// checkout's .git -- scripts/evals-container resolves the rev on the HOST,
// where the worktree's gitdir pointer resolves normally either way. That is
// exactly why resolving it here, rather than in-container, is the fix.
function makeLinkedWorktreeSuperpowersRoot(root: string): string {
  const primary = join(root, 'superpowers-primary');
  const worktree = join(root, 'superpowers-worktree');
  mkdirSync(primary);
  gitInit(primary);
  spawnSync('git', [
    '-C',
    primary,
    'worktree',
    'add',
    '-q',
    '-b',
    'wt-branch',
    worktree,
  ]);
  return worktree;
}

function removeResultProbeFiles(): void {
  const results = join(REPO, 'results');
  try {
    for (const entry of readdirSync(results)) {
      if (entry.startsWith('.evals-container-probe.')) {
        unlinkSync(join(results, entry));
      }
    }
  } catch {
    return;
  }
}

function resultProbeFiles(): string[] {
  try {
    return readdirSync(join(REPO, 'results')).filter((entry) =>
      entry.startsWith('.evals-container-probe.'),
    );
  } catch {
    return [];
  }
}

function removeContainerRuntimeFiles(): void {
  rmSync(join(REPO, 'results', '.container-runtime'), {
    recursive: true,
    force: true,
  });
}

describe('scripts/evals-container', () => {
  test('build calls Docker build with the container Dockerfile and repo context', () => {
    const harness = makeHarness();
    try {
      const proc = runWrapper(harness, ['build']);

      expect(proc.error).toBeUndefined();
      expect(proc.status).toBe(0);
      const args = dockerCommand(harness.dockerLog, 'build');
      const dockerfileIndex = args.indexOf('-f');
      expect(dockerfileIndex).toBeGreaterThanOrEqual(0);
      expectDockerfileArg(args[dockerfileIndex + 1]);
      const contextIndex = args.indexOf('--build-context');
      expect(contextIndex).toBeGreaterThanOrEqual(0);
      expect(args[contextIndex + 1]).toBe(
        `gauntlet=${realpathSync(harness.gauntletRoot)}`,
      );
      expect(args[args.length - 1]).toBe(REPO);
    } finally {
      rmSync(harness.root, { recursive: true, force: true });
    }
  });

  test('build fails before Docker when the Gauntlet checkout is missing', () => {
    const harness = makeHarness({ GAUNTLET_ROOT: undefined });
    try {
      rmSync(harness.gauntletRoot, { recursive: true, force: true });

      const proc = runWrapper(harness, [
        '--gauntlet-root',
        harness.gauntletRoot,
        'build',
      ]);

      expect(proc.error).toBeUndefined();
      expect(proc.status).not.toBe(0);
      expect(proc.stderr).toContain('Gauntlet root does not exist');
      expect(dockerLogLines(harness.dockerLog)).toEqual([]);
    } finally {
      rmSync(harness.root, { recursive: true, force: true });
    }
  });

  test('non-exec commands reject arguments placed after the command', () => {
    for (const command of ['build', 'up', 'down', 'status', 'shell']) {
      const harness = makeHarness();
      try {
        const proc = runWrapper(harness, [command, '--env-file', 'prod.env']);

        expect(proc.error).toBeUndefined();
        expect(proc.status).not.toBe(0);
        expect(proc.stderr).toContain(`unexpected argument after ${command}`);
        expect(proc.stderr).toContain('put options before the command');
        expect(dockerLogLines(harness.dockerLog)).toEqual([]);
      } finally {
        rmSync(harness.root, { recursive: true, force: true });
      }
    }
  });

  test('up bind-mounts evals, superpowers, and results paths', () => {
    const harness = makeHarness();
    try {
      const superpowersRoot = makeSuperpowersRoot(harness.root);
      const proc = runWrapper(harness, [
        '--superpowers-root',
        superpowersRoot,
        'up',
      ]);

      expect(proc.error).toBeUndefined();
      expect(proc.status).toBe(0);
      const args = dockerCommand(harness.dockerLog, 'run');
      expectMountSource(mountForTarget(args, '/workspace/evals'), REPO);
      expectMountSource(
        mountForTarget(args, '/workspace/superpowers'),
        superpowersRoot,
      );
      expectMountSource(
        mountForTarget(args, '/workspace/evals/results'),
        join(REPO, 'results'),
      );
    } finally {
      rmSync(harness.root, { recursive: true, force: true });
    }
  });

  test('up creates and enforces a private host results root', () => {
    const harness = makeHarness();
    const results = join(REPO, 'results');
    mkdirSync(results, { recursive: true });
    chmodSync(results, 0o755);
    try {
      const superpowersRoot = makeSuperpowersRoot(harness.root);
      const proc = runWrapper(harness, [
        '--superpowers-root',
        superpowersRoot,
        'up',
      ]);

      expect(proc.error).toBeUndefined();
      expect(proc.status).toBe(0);
      expect(statSync(results).mode & 0o777).toBe(0o700);
    } finally {
      chmodSync(results, 0o700);
      rmSync(harness.root, { recursive: true, force: true });
    }
  });

  test('up passes the host-resolved superpowers rev and dirty flag to the container', () => {
    const harness = makeHarness();
    try {
      const superpowersRoot = makeGitSuperpowersRoot(harness.root);
      const proc = runWrapper(harness, [
        '--superpowers-root',
        superpowersRoot,
        'up',
      ]);

      expect(proc.error).toBeUndefined();
      expect(proc.status).toBe(0);
      const args = dockerCommand(harness.dockerLog, 'run');
      expect(envValue(args, 'QUORUM_SUPERPOWERS_REV')).toBe(
        gitRevParseHead(superpowersRoot),
      );
      expect(envValue(args, 'QUORUM_SUPERPOWERS_DIRTY')).toBe('false');
    } finally {
      rmSync(harness.root, { recursive: true, force: true });
    }
  });

  test('up reports the dirty flag when superpowers root has uncommitted changes', () => {
    const harness = makeHarness();
    try {
      const superpowersRoot = makeGitSuperpowersRoot(harness.root);
      writeFileSync(join(superpowersRoot, 'dirt.txt'), 'x');
      const proc = runWrapper(harness, [
        '--superpowers-root',
        superpowersRoot,
        'up',
      ]);

      expect(proc.error).toBeUndefined();
      expect(proc.status).toBe(0);
      const args = dockerCommand(harness.dockerLog, 'run');
      expect(envValue(args, 'QUORUM_SUPERPOWERS_DIRTY')).toBe('true');
    } finally {
      rmSync(harness.root, { recursive: true, force: true });
    }
  });

  // PRI-2494 item 22: a linked git worktree's rev must resolve correctly
  // because scripts/evals-container resolves it on the HOST (where the
  // worktree's gitdir pointer is reachable), not in-container.
  test('up resolves the superpowers rev correctly for a linked git worktree', () => {
    const harness = makeHarness();
    try {
      const superpowersRoot = makeLinkedWorktreeSuperpowersRoot(harness.root);
      const proc = runWrapper(harness, [
        '--superpowers-root',
        superpowersRoot,
        'up',
      ]);

      expect(proc.error).toBeUndefined();
      expect(proc.status).toBe(0);
      const args = dockerCommand(harness.dockerLog, 'run');
      const rev = envValue(args, 'QUORUM_SUPERPOWERS_REV');
      expect(rev).toBe(gitRevParseHead(superpowersRoot));
      expect(rev).not.toBe('');
      expect(envValue(args, 'QUORUM_SUPERPOWERS_DIRTY')).toBe('false');
    } finally {
      rmSync(harness.root, { recursive: true, force: true });
    }
  });

  test('up omits the superpowers rev env vars when superpowers root is not a git repo', () => {
    const harness = makeHarness();
    try {
      const superpowersRoot = makeSuperpowersRoot(harness.root);
      const proc = runWrapper(harness, [
        '--superpowers-root',
        superpowersRoot,
        'up',
      ]);

      expect(proc.error).toBeUndefined();
      expect(proc.status).toBe(0);
      const args = dockerCommand(harness.dockerLog, 'run');
      expect(envValue(args, 'QUORUM_SUPERPOWERS_REV')).toBeUndefined();
      expect(envValue(args, 'QUORUM_SUPERPOWERS_DIRTY')).toBeUndefined();
    } finally {
      rmSync(harness.root, { recursive: true, force: true });
    }
  });

  test('up gives the numeric container user writable host-visible home and XDG state', () => {
    const harness = makeHarness();
    try {
      const superpowersRoot = makeSuperpowersRoot(harness.root);
      const proc = runWrapper(harness, [
        '--superpowers-root',
        superpowersRoot,
        'up',
      ]);

      expect(proc.error).toBeUndefined();
      expect(proc.status).toBe(0);
      const args = dockerCommand(harness.dockerLog, 'run');
      expect(envValue(args, 'HOME')).toBe(
        '/workspace/evals/results/.container-home',
      );
      expect(envValue(args, 'XDG_CACHE_HOME')).toBe(
        '/workspace/evals/results/.container-home/.cache',
      );
      expect(envValue(args, 'XDG_CONFIG_HOME')).toBe(
        '/workspace/evals/results/.container-home/.config',
      );
      expect(envValue(args, 'XDG_STATE_HOME')).toBe(
        '/workspace/evals/results/.container-home/.local/state',
      );
      expect(envValue(args, 'TMPDIR')).toBe('/tmp');
      expect(args.slice(-3, -1)).toEqual(['bash', '-lc']);
      expect(args.at(-1)).toContain('mkdir -p "$HOME"');
      expect(args.at(-1)).toContain('exec sleep infinity');
    } finally {
      rmSync(harness.root, { recursive: true, force: true });
    }
  });

  test('up mounts host-generated passwd and group files for the numeric container user', () => {
    const harness = makeHarness();
    removeContainerRuntimeFiles();
    try {
      const superpowersRoot = makeSuperpowersRoot(harness.root);
      const proc = runWrapper(harness, [
        '--superpowers-root',
        superpowersRoot,
        'up',
      ]);

      expect(proc.error).toBeUndefined();
      expect(proc.status).toBe(0);
      const args = dockerCommand(harness.dockerLog, 'run');
      const passwdMount = mountForTarget(args, '/etc/passwd');
      const groupMount = mountForTarget(args, '/etc/group');
      expectReadonly(passwdMount);
      expectReadonly(groupMount);

      const uid = process.getuid?.();
      const gid = process.getgid?.();
      expect(uid).toBeDefined();
      expect(gid).toBeDefined();
      const passwd = readFileSync(
        join(REPO, 'results', '.container-runtime', 'passwd'),
        'utf8',
      );
      const group = readFileSync(
        join(REPO, 'results', '.container-runtime', 'group'),
        'utf8',
      );
      expect(passwd).toContain(`evals:x:${uid}:${gid}:`);
      expect(passwd).toContain('/workspace/evals/results/.container-home');
      expect(group).toContain(`evals:x:${gid}:`);
    } finally {
      removeContainerRuntimeFiles();
      rmSync(harness.root, { recursive: true, force: true });
    }
  });

  test('up mounts an explicit env file read-only at the credential path', () => {
    const harness = makeHarness();
    try {
      const superpowersRoot = makeSuperpowersRoot(harness.root);
      const envFile = writeEnvFile(harness.root);
      const proc = runWrapper(harness, [
        '--superpowers-root',
        superpowersRoot,
        '--env-file',
        envFile,
        'up',
      ]);

      expect(proc.error).toBeUndefined();
      expect(proc.status).toBe(0);
      const args = dockerCommand(harness.dockerLog, 'run');
      const mount = mountForTarget(args, '/run/evals/credentials.env');
      expectMountSource(mount, envFile);
      expectReadonly(mount);
    } finally {
      rmSync(harness.root, { recursive: true, force: true });
    }
  });

  test('up fails before Docker when an explicit env file is missing', () => {
    const harness = makeHarness();
    try {
      const superpowersRoot = makeSuperpowersRoot(harness.root);
      const missingEnvFile = join(harness.root, 'missing.env');
      const proc = runWrapper(harness, [
        '--superpowers-root',
        superpowersRoot,
        '--env-file',
        missingEnvFile,
        'up',
      ]);

      expect(proc.error).toBeUndefined();
      expect(proc.status).not.toBe(0);
      expect(proc.stderr).toContain(missingEnvFile);
      expect(dockerLogLines(harness.dockerLog)).toEqual([]);
    } finally {
      rmSync(harness.root, { recursive: true, force: true });
    }
  });

  test('up fails before Docker when an explicit env file is unreadable', () => {
    const harness = makeHarness();
    const envFile = writeEnvFile(harness.root);
    try {
      const superpowersRoot = makeSuperpowersRoot(harness.root);
      chmodSync(envFile, 0o000);
      const proc = runWrapper(harness, [
        '--superpowers-root',
        superpowersRoot,
        '--env-file',
        envFile,
        'up',
      ]);

      expect(proc.error).toBeUndefined();
      expect(proc.status).not.toBe(0);
      expect(proc.stderr).toContain(envFile);
      expect(proc.stderr).toContain('readable');
      expect(dockerLogLines(harness.dockerLog)).toEqual([]);
    } finally {
      chmodSync(envFile, 0o600);
      rmSync(harness.root, { recursive: true, force: true });
    }
  });

  test('up mounts an explicit Codex auth directory read-only', () => {
    const harness = makeHarness();
    try {
      const superpowersRoot = makeSuperpowersRoot(harness.root);
      const envFile = writeEnvFile(harness.root);
      const codexAuth = join(harness.root, 'codex-auth');
      mkdirSync(codexAuth);
      const proc = runWrapper(harness, [
        '--superpowers-root',
        superpowersRoot,
        '--env-file',
        envFile,
        '--auth',
        `codex=${codexAuth}`,
        'up',
      ]);

      expect(proc.error).toBeUndefined();
      expect(proc.status).toBe(0);
      const args = dockerCommand(harness.dockerLog, 'run');
      const mount = mountForTarget(args, '/auth/codex');
      expectMountSource(mount, codexAuth);
      expectReadonly(mount);
    } finally {
      rmSync(harness.root, { recursive: true, force: true });
    }
  });

  test('up canonicalizes relative explicit mount sources before calling Docker', () => {
    const harness = makeHarness();
    try {
      const cwd = join(harness.root, 'cwd');
      const superpowersRoot = join(cwd, 'superpowers');
      const codexAuth = join(cwd, 'codex-auth');
      const envFile = join(cwd, 'credentials.env');
      mkdirSync(superpowersRoot, { recursive: true });
      mkdirSync(codexAuth);
      writeFileSync(envFile, 'OPENAI_API_KEY=sk-test\n');

      const proc = runWrapper(
        harness,
        [
          '--superpowers-root',
          'superpowers',
          '--env-file',
          'credentials.env',
          '--auth',
          'codex=codex-auth',
          'up',
        ],
        { cwd },
      );

      expect(proc.error).toBeUndefined();
      expect(proc.status).toBe(0);
      const args = dockerCommand(harness.dockerLog, 'run');
      expectMountSource(
        mountForTarget(args, '/workspace/superpowers'),
        superpowersRoot,
      );
      expectMountSource(
        mountForTarget(args, '/run/evals/credentials.env'),
        envFile,
      );
      expectMountSource(mountForTarget(args, '/auth/codex'), codexAuth);
    } finally {
      rmSync(harness.root, { recursive: true, force: true });
    }
  });

  test('up rejects mount sources with commas before calling Docker', () => {
    const harness = makeHarness();
    try {
      const commaRoot = join(harness.root, 'superpowers,with-comma');
      mkdirSync(commaRoot);
      const proc = runWrapper(harness, ['--superpowers-root', commaRoot, 'up']);

      expect(proc.error).toBeUndefined();
      expect(proc.status).not.toBe(0);
      expect(proc.stderr).toContain('comma');
      expect(proc.stderr).toContain(commaRoot);
      expect(dockerLogLines(harness.dockerLog)).toEqual([]);
    } finally {
      rmSync(harness.root, { recursive: true, force: true });
    }
  });

  test('up fails before Docker when an explicit auth directory is missing', () => {
    const harness = makeHarness();
    try {
      const superpowersRoot = makeSuperpowersRoot(harness.root);
      const envFile = writeEnvFile(harness.root);
      const missingAuth = join(harness.root, 'missing-codex-auth');
      const proc = runWrapper(harness, [
        '--superpowers-root',
        superpowersRoot,
        '--env-file',
        envFile,
        '--auth',
        `codex=${missingAuth}`,
        'up',
      ]);

      expect(proc.error).toBeUndefined();
      expect(proc.status).not.toBe(0);
      expect(proc.stderr).toContain(missingAuth);
      expect(dockerLogLines(harness.dockerLog)).toEqual([]);
    } finally {
      rmSync(harness.root, { recursive: true, force: true });
    }
  });

  test('up does not mount the host Docker socket', () => {
    const harness = makeHarness();
    try {
      const superpowersRoot = makeSuperpowersRoot(harness.root);
      const proc = runWrapper(harness, [
        '--superpowers-root',
        superpowersRoot,
        'up',
      ]);

      expect(proc.error).toBeUndefined();
      expect(proc.status).toBe(0);
      expect(dockerLogLines(harness.dockerLog).join('\n')).not.toContain(
        '/var/run/docker.sock',
      );
    } finally {
      rmSync(harness.root, { recursive: true, force: true });
    }
  });

  test('up with an already running container prints its name and does not run a new container', () => {
    const harness = makeHarness();
    try {
      const name = 'evals-running-container';
      writeDockerState(harness, { exists: true, running: true, name });
      const proc = runWrapper(harness, ['--name', name, 'up']);

      expect(proc.error).toBeUndefined();
      expect(proc.status).toBe(0);
      expect(proc.stdout).toBe(`${name}\n`);
      expect(dockerCommandsNamed(harness.dockerLog, 'run')).toEqual([]);
      expectNoGenericInspect(harness.dockerLog);
    } finally {
      rmSync(harness.root, { recursive: true, force: true });
    }
  });

  test('up with an existing stopped container starts it and does not run a new container', () => {
    const harness = makeHarness();
    try {
      const name = 'evals-stopped-container';
      writeDockerState(harness, { exists: true, running: false, name });
      const proc = runWrapper(harness, ['--name', name, 'up']);

      expect(proc.error).toBeUndefined();
      expect(proc.status).toBe(0);
      expect(dockerCommand(harness.dockerLog, 'start').slice(1)).toEqual([
        name,
      ]);
      expect(dockerCommandsNamed(harness.dockerLog, 'run')).toEqual([]);
      expectNoGenericInspect(harness.dockerLog);
    } finally {
      rmSync(harness.root, { recursive: true, force: true });
    }
  });

  test('up refuses to reuse an existing container when explicit mounts were requested', () => {
    const harness = makeHarness();
    try {
      const name = 'evals-existing-container';
      const envFile = writeEnvFile(harness.root);
      writeDockerState(harness, { exists: true, running: true, name });
      const proc = runWrapper(harness, [
        '--name',
        name,
        '--env-file',
        envFile,
        'up',
      ]);

      expect(proc.error).toBeUndefined();
      expect(proc.status).not.toBe(0);
      expect(proc.stderr).toContain(name);
      expect(proc.stderr).toContain('down');
      expect(dockerCommandsNamed(harness.dockerLog, 'run')).toEqual([]);
      expect(dockerCommandsNamed(harness.dockerLog, 'start')).toEqual([]);
      expectNoGenericInspect(harness.dockerLog);
    } finally {
      rmSync(harness.root, { recursive: true, force: true });
    }
  });

  test('status reports missing, stopped, and running containers', () => {
    const missing = makeHarness();
    const stopped = makeHarness();
    const running = makeHarness();
    try {
      const name = 'evals-status-container';
      writeDockerState(stopped, { exists: true, running: false, name });
      writeDockerState(running, { exists: true, running: true, name });

      const missingStatus = runWrapper(missing, ['--name', name, 'status']);
      const stoppedStatus = runWrapper(stopped, ['--name', name, 'status']);
      const runningStatus = runWrapper(running, ['--name', name, 'status']);

      expect(missingStatus.error).toBeUndefined();
      expect(stoppedStatus.error).toBeUndefined();
      expect(runningStatus.error).toBeUndefined();
      expect(missingStatus.status).toBe(0);
      expect(stoppedStatus.status).toBe(0);
      expect(runningStatus.status).toBe(0);
      expect(missingStatus.stdout).toContain('missing');
      expect(stoppedStatus.stdout).toContain('stopped');
      expect(runningStatus.stdout).toContain('running');
      expectNoGenericInspect(stopped.dockerLog);
      expectNoGenericInspect(running.dockerLog);
    } finally {
      rmSync(missing.root, { recursive: true, force: true });
      rmSync(stopped.root, { recursive: true, force: true });
      rmSync(running.root, { recursive: true, force: true });
    }
  });

  test('down stops then removes a running container', () => {
    const harness = makeHarness();
    try {
      const name = 'evals-down-running-container';
      writeDockerState(harness, { exists: true, running: true, name });
      const proc = runWrapper(harness, ['--name', name, 'down']);

      expect(proc.error).toBeUndefined();
      expect(proc.status).toBe(0);
      const commands = dockerCommands(harness.dockerLog);
      const stopIndex = commands.findIndex((args) => args[0] === 'stop');
      const rmIndex = commands.findIndex((args) => args[0] === 'rm');
      expect(stopIndex).toBeGreaterThanOrEqual(0);
      expect(rmIndex).toBeGreaterThan(stopIndex);
      expect(commands[stopIndex]?.slice(1)).toEqual([name]);
      expect(commands[rmIndex]?.slice(1)).toEqual([name]);
      expectNoGenericInspect(harness.dockerLog);
    } finally {
      rmSync(harness.root, { recursive: true, force: true });
    }
  });

  test('down removes a stopped container without stopping it', () => {
    const harness = makeHarness();
    try {
      const name = 'evals-down-stopped-container';
      writeDockerState(harness, { exists: true, running: false, name });
      const proc = runWrapper(harness, ['--name', name, 'down']);

      expect(proc.error).toBeUndefined();
      expect(proc.status).toBe(0);
      expect(dockerCommandsNamed(harness.dockerLog, 'stop')).toEqual([]);
      expect(dockerCommand(harness.dockerLog, 'rm').slice(1)).toEqual([name]);
      expectNoGenericInspect(harness.dockerLog);
    } finally {
      rmSync(harness.root, { recursive: true, force: true });
    }
  });

  test('exec passes raw trailing args directly to docker exec', () => {
    const harness = makeHarness();
    try {
      const proc = runWrapper(harness, [
        '--name',
        'evals-test-container',
        'exec',
        'bash',
        '-lc',
        'echo ok',
      ]);

      expect(proc.error).toBeUndefined();
      expect(proc.status).toBe(0);
      const args = dockerCommand(harness.dockerLog, 'exec');
      expect(args[1]).toBe('evals-test-container');
      expect(args.slice(2)).toEqual(['bash', '-lc', 'echo ok']);
      expect(args.slice(2)).not.toContain('--');
    } finally {
      rmSync(harness.root, { recursive: true, force: true });
    }
  });

  test('exec quorum creates and removes a host-visible results probe before the final command', () => {
    const harness = makeHarness();
    removeResultProbeFiles();
    try {
      const proc = runWrapper(harness, [
        '--name',
        'evals-test-container',
        'exec',
        'quorum',
        'run-all',
        '--jobs',
        '1',
      ]);

      expect(proc.error).toBeUndefined();
      expect(proc.status).toBe(0);
      const execs = dockerCommandsNamed(harness.dockerLog, 'exec');
      expect(execs).toHaveLength(2);
      expect(execs[0]?.slice(1, 4)).toEqual([
        'evals-test-container',
        'bash',
        '-lc',
      ]);
      expect(execs[0]?.[4]).toContain('/workspace/evals/results');
      expect(execs[0]?.[4]).toContain(': >');
      expect(execs[1]?.slice(1)).toEqual([
        'evals-test-container',
        'quorum',
        'run-all',
        '--jobs',
        '1',
      ]);
      expect(resultProbeFiles()).toEqual([]);
    } finally {
      removeResultProbeFiles();
      rmSync(harness.root, { recursive: true, force: true });
    }
  });

  test('exec quorum fails before the final command when the results probe is not host-visible', () => {
    const harness = makeHarness({
      EVALS_CONTAINER_RESULTS_HOST_VISIBLE_FAIL: 'true',
    });
    removeResultProbeFiles();
    try {
      const proc = runWrapper(harness, [
        '--name',
        'evals-test-container',
        'exec',
        'quorum',
        'list',
      ]);

      expect(proc.error).toBeUndefined();
      expect(proc.status).not.toBe(0);
      expect(proc.stderr).toContain('host-visible');
      const execs = dockerCommandsNamed(harness.dockerLog, 'exec');
      expect(execs.some((args) => args[2] === 'quorum')).toBe(false);
    } finally {
      removeResultProbeFiles();
      rmSync(harness.root, { recursive: true, force: true });
    }
  });

  test('exec quorum fails before the final command when the results probe fails', () => {
    const harness = makeHarness({
      EVALS_CONTAINER_RESULTS_PROBE_FAIL: 'true',
    });
    try {
      const proc = runWrapper(harness, [
        '--name',
        'evals-test-container',
        'exec',
        'quorum',
        'list',
      ]);

      expect(proc.error).toBeUndefined();
      expect(proc.status).not.toBe(0);
      expect(proc.stderr).toContain('/workspace/evals/results');
      const execs = dockerCommandsNamed(harness.dockerLog, 'exec');
      expect(execs).toHaveLength(1);
      expect(execs[0]?.slice(1, 4)).toEqual([
        'evals-test-container',
        'bash',
        '-lc',
      ]);
      expect(execs[0]?.[4]).toContain('/workspace/evals/results');
      expect(execs.some((args) => args[2] === 'quorum')).toBe(false);
    } finally {
      rmSync(harness.root, { recursive: true, force: true });
    }
  });
});

// A host home stuffed with every OAuth auth directory the wrapper would
// otherwise fall back to — scoped mode must never mount any of them.
function makeHostileHome(root: string): string {
  const home = join(root, 'hostile-home');
  for (const dir of ['.codex', '.gemini', '.kimi-code', '.pi']) {
    mkdirSync(join(home, dir), { recursive: true });
  }
  return home;
}

function authMountTargets(args: string[]): string[] {
  return mountArgs(args)
    .flatMap((mount) => mount.split(','))
    .filter((part) => part.startsWith('target=/auth/'))
    .map((part) => part.slice('target='.length));
}

describe('scripts/evals-container scoped mode', () => {
  test('--no-default-auth up ignores every host-home auth fallback and prints the captured container id', () => {
    const harness = makeHarness();
    harness.env['HOME'] = makeHostileHome(harness.root);
    removeResultProbeFiles();
    try {
      const superpowersRoot = makeSuperpowersRoot(harness.root);
      const envFile = join(harness.root, 'agent.env');
      writeFileSync(envFile, '');

      const proc = runWrapper(harness, [
        '--superpowers-root',
        superpowersRoot,
        '--env-file',
        envFile,
        '--no-default-auth',
        'up',
      ]);

      expect(proc.error).toBeUndefined();
      expect(proc.status).toBe(0);
      expect(proc.stdout).toBe(`${FAKE_CONTAINER_ID}\n`);
      const args = dockerCommand(harness.dockerLog, 'run');
      expect(authMountTargets(args)).toEqual([]);
      const envMount = mountForTarget(args, '/run/evals/credentials.env');
      expectMountSource(envMount, envFile);
      expectReadonly(envMount);
    } finally {
      removeResultProbeFiles();
      rmSync(harness.root, { recursive: true, force: true });
    }
  });

  test('legacy up without --no-default-auth still applies host-home auth fallbacks', () => {
    const harness = makeHarness();
    const home = makeHostileHome(harness.root);
    harness.env['HOME'] = home;
    try {
      const superpowersRoot = makeSuperpowersRoot(harness.root);
      const proc = runWrapper(harness, [
        '--superpowers-root',
        superpowersRoot,
        'up',
      ]);

      expect(proc.error).toBeUndefined();
      expect(proc.status).toBe(0);
      const args = dockerCommand(harness.dockerLog, 'run');
      expect(authMountTargets(args).sort()).toEqual([
        '/auth/codex',
        '/auth/gemini',
        '/auth/kimi-code',
        '/auth/pi',
      ]);
      expectMountSource(
        mountForTarget(args, '/auth/codex'),
        join(home, '.codex'),
      );
    } finally {
      rmSync(harness.root, { recursive: true, force: true });
    }
  });

  test('--no-default-auth up mounts exactly the explicit auth directory and probes results against the captured id', () => {
    const harness = makeHarness();
    harness.env['HOME'] = makeHostileHome(harness.root);
    removeResultProbeFiles();
    try {
      const superpowersRoot = makeSuperpowersRoot(harness.root);
      const envFile = writeEnvFile(harness.root);
      const geminiAuth = join(harness.root, 'gemini-auth');
      mkdirSync(geminiAuth);

      const proc = runWrapper(harness, [
        '--superpowers-root',
        superpowersRoot,
        '--env-file',
        envFile,
        '--auth',
        `gemini=${geminiAuth}`,
        '--no-default-auth',
        'up',
      ]);

      expect(proc.error).toBeUndefined();
      expect(proc.status).toBe(0);
      expect(proc.stdout).toBe(`${FAKE_CONTAINER_ID}\n`);
      const args = dockerCommand(harness.dockerLog, 'run');
      expect(authMountTargets(args)).toEqual(['/auth/gemini']);
      expectMountSource(mountForTarget(args, '/auth/gemini'), geminiAuth);
      // The cidfile OPTION must precede the image tag: real docker run
      // treats every argument after the image as the container command, so
      // an appended --cidfile would never reach docker as an option.
      // args[0] is the fake-docker subcommand 'run'; the image is the first
      // non-flag token that is not the value of a value-taking option.
      const VALUE_TAKING = new Set([
        '--name',
        '--cidfile',
        '--user',
        '--workdir',
        '--env',
        '--mount',
      ]);
      let imageIndex = -1;
      for (let i = 1; i < args.length; i++) {
        const arg = args[i] ?? '';
        if (VALUE_TAKING.has(arg)) {
          i++;
          continue;
        }
        if (!arg.startsWith('-')) {
          imageIndex = i;
          break;
        }
      }
      const cidfileIndex = args.indexOf('--cidfile');
      expect(imageIndex).toBeGreaterThan(0);
      expect(cidfileIndex).toBeGreaterThan(-1);
      expect(cidfileIndex).toBeLessThan(imageIndex);

      // The scoped results probe targets the immutable captured id, never
      // the mutable configured name.
      const execs = dockerCommandsNamed(harness.dockerLog, 'exec');
      expect(execs).toHaveLength(1);
      expect(execs[0]?.slice(1, 4)).toEqual([FAKE_CONTAINER_ID, 'bash', '-lc']);
      expect(execs[0]?.[4]).toContain('/workspace/evals/results');
      expect(resultProbeFiles()).toEqual([]);
    } finally {
      removeResultProbeFiles();
      rmSync(harness.root, { recursive: true, force: true });
    }
  });

  test('--no-default-auth refuses stale-container reuse', () => {
    const harness = makeHarness();
    try {
      const name = 'evals-scoped-stale';
      writeDockerState(harness, {
        exists: true,
        running: true,
        name,
        id: FAKE_CONTAINER_ID,
      });
      const envFile = join(harness.root, 'agent.env');
      writeFileSync(envFile, '');
      const proc = runWrapper(harness, [
        '--name',
        name,
        '--env-file',
        envFile,
        '--no-default-auth',
        'up',
      ]);

      expect(proc.error).toBeUndefined();
      expect(proc.status).not.toBe(0);
      expect(proc.stderr).toContain('down');
      expect(dockerCommandsNamed(harness.dockerLog, 'run')).toEqual([]);
      expect(dockerCommandsNamed(harness.dockerLog, 'start')).toEqual([]);
    } finally {
      rmSync(harness.root, { recursive: true, force: true });
    }
  });

  test('--no-default-auth is accepted and behaviorally inert outside up', () => {
    const statusHarness = makeHarness();
    const downHarness = makeHarness();
    try {
      const name = 'evals-scoped-inert';
      const statusProc = runWrapper(statusHarness, [
        '--name',
        name,
        '--no-default-auth',
        'status',
      ]);
      expect(statusProc.error).toBeUndefined();
      expect(statusProc.status).toBe(0);
      expect(statusProc.stdout).toContain('missing');

      writeDockerState(downHarness, {
        exists: true,
        running: true,
        name,
        id: FAKE_CONTAINER_ID,
      });
      const downProc = runWrapper(downHarness, [
        '--name',
        name,
        '--no-default-auth',
        'down',
      ]);
      expect(downProc.error).toBeUndefined();
      expect(downProc.status).toBe(0);
      expect(dockerCommand(downHarness.dockerLog, 'rm')).toBeDefined();
    } finally {
      rmSync(statusHarness.root, { recursive: true, force: true });
      rmSync(downHarness.root, { recursive: true, force: true });
    }
  });

  test('a scoped up whose results probe fails rolls back the captured id, never the configured name', () => {
    const harness = makeHarness({ EVALS_CONTAINER_RESULTS_PROBE_FAIL: 'true' });
    removeResultProbeFiles();
    try {
      const superpowersRoot = makeSuperpowersRoot(harness.root);
      const envFile = writeEnvFile(harness.root);

      const proc = runWrapper(harness, [
        '--superpowers-root',
        superpowersRoot,
        '--env-file',
        envFile,
        '--no-default-auth',
        'up',
      ]);

      expect(proc.error).toBeUndefined();
      expect(proc.status).not.toBe(0);
      expect(proc.stderr).toContain('results');
      const rms = dockerCommandsNamed(harness.dockerLog, 'rm');
      expect(rms).toEqual([['rm', '-f', FAKE_CONTAINER_ID]]);
      expect(dockerCommandsNamed(harness.dockerLog, 'stop')).toEqual([]);
    } finally {
      removeResultProbeFiles();
      rmSync(harness.root, { recursive: true, force: true });
    }
  });

  test('exec with --expected-container-id verifies the configured name resolves to the id and targets the immutable id', () => {
    const harness = makeHarness();
    try {
      const name = 'evals-scoped-exec';
      writeDockerState(harness, {
        exists: true,
        running: true,
        name,
        id: FAKE_CONTAINER_ID,
      });

      const proc = runWrapper(harness, [
        '--name',
        name,
        '--expected-container-id',
        FAKE_CONTAINER_ID,
        'exec',
        'quorum',
        'list',
      ]);

      expect(proc.error).toBeUndefined();
      expect(proc.status).toBe(0);
      const commands = dockerCommands(harness.dockerLog);
      expect(commands).toEqual([
        ['container', 'inspect', '-f', '{{.Id}}', name],
        ['exec', FAKE_CONTAINER_ID, 'quorum', 'list'],
      ]);
    } finally {
      rmSync(harness.root, { recursive: true, force: true });
    }
  });

  test('--exec-env-file is emitted after docker exec and before the immutable id', () => {
    const harness = makeHarness();
    try {
      const name = 'evals-scoped-exec-env';
      writeDockerState(harness, {
        exists: true,
        running: true,
        name,
        id: FAKE_CONTAINER_ID,
      });
      const execEnvFile = join(
        realpathSync(harness.root),
        'supervisor.exec.env',
      );
      writeFileSync(execEnvFile, 'ANTHROPIC_API_KEY=grader\n');

      const proc = runWrapper(harness, [
        '--name',
        name,
        '--expected-container-id',
        FAKE_CONTAINER_ID,
        '--exec-env-file',
        execEnvFile,
        'exec',
        'quorum',
        'run',
      ]);

      expect(proc.error).toBeUndefined();
      expect(proc.status).toBe(0);
      expect(dockerCommand(harness.dockerLog, 'exec')).toEqual([
        'exec',
        '--env-file',
        execEnvFile,
        FAKE_CONTAINER_ID,
        'quorum',
        'run',
      ]);
    } finally {
      rmSync(harness.root, { recursive: true, force: true });
    }
  });

  test('a configured-name replacement fails before any child execution', () => {
    const harness = makeHarness();
    try {
      const name = 'evals-scoped-replaced';
      writeDockerState(harness, {
        exists: true,
        running: true,
        name,
        id: 'replacement0123456789abcdef0123456789abcdef0123456789abcdef0123',
      });

      const proc = runWrapper(harness, [
        '--name',
        name,
        '--expected-container-id',
        FAKE_CONTAINER_ID,
        'exec',
        'quorum',
        'list',
      ]);

      expect(proc.error).toBeUndefined();
      expect(proc.status).not.toBe(0);
      expect(proc.stderr).toContain('replacement');
      expect(dockerCommands(harness.dockerLog)).toEqual([
        ['container', 'inspect', '-f', '{{.Id}}', name],
      ]);
    } finally {
      rmSync(harness.root, { recursive: true, force: true });
    }
  });

  test('a missing configured container fails the id verification before any child execution', () => {
    const harness = makeHarness();
    try {
      const proc = runWrapper(harness, [
        '--name',
        'evals-scoped-missing',
        '--expected-container-id',
        FAKE_CONTAINER_ID,
        'exec',
        'quorum',
        'list',
      ]);

      expect(proc.error).toBeUndefined();
      expect(proc.status).not.toBe(0);
      // Case-specific diagnostics plus exact no-Docker behavior: an
      // unknown-flag rejection can no longer pass this test vacuously.
      expect(proc.stderr).toContain('not inspectable');
      expect(dockerCommands(harness.dockerLog)).toEqual([
        ['container', 'inspect', '-f', '{{.Id}}', 'evals-scoped-missing'],
      ]);
      expect(dockerCommandsNamed(harness.dockerLog, 'exec')).toEqual([]);
    } finally {
      rmSync(harness.root, { recursive: true, force: true });
    }
  });

  test('--exec-env-file and --expected-container-id are validated before any docker call', () => {
    const cases: {
      label: string;
      fragment: string;
      prepare: (harness: ReturnType<typeof makeHarness>) => string[];
    }[] = [
      {
        label: 'relative exec env file',
        fragment: 'absolute path',
        prepare: () => [
          '--expected-container-id',
          FAKE_CONTAINER_ID,
          '--exec-env-file',
          'relative/agent.env',
          'exec',
          'quorum',
        ],
      },
      {
        label: 'final-symlinked exec env file',
        fragment: 'symlink',
        prepare: (harness) => {
          const real = join(harness.root, 'real.env');
          const link = join(harness.root, 'link.env');
          writeFileSync(real, 'X=1\n');
          symlinkSync(real, link);
          return [
            '--expected-container-id',
            FAKE_CONTAINER_ID,
            '--exec-env-file',
            link,
            'exec',
            'quorum',
          ];
        },
      },
      {
        label: 'intermediate-symlinked exec env file path',
        fragment: 'symlink',
        prepare: (harness) => {
          const realDir = join(harness.root, 'real-dir');
          const linkDir = join(harness.root, 'link-dir');
          mkdirSync(realDir, { recursive: true });
          writeFileSync(join(realDir, 'exec.env'), 'X=1\n');
          symlinkSync(realDir, linkDir);
          return [
            '--expected-container-id',
            FAKE_CONTAINER_ID,
            '--exec-env-file',
            join(linkDir, 'exec.env'),
            'exec',
            'quorum',
          ];
        },
      },
      {
        label: 'missing exec env file',
        fragment: 'not a regular file',
        prepare: (harness) => [
          '--expected-container-id',
          FAKE_CONTAINER_ID,
          '--exec-env-file',
          join(harness.root, 'missing.env'),
          'exec',
          'quorum',
        ],
      },
      {
        label: 'unreadable exec env file',
        fragment: 'not readable',
        prepare: (harness) => {
          const file = join(harness.root, 'unreadable.env');
          writeFileSync(file, 'X=1\n');
          chmodSync(file, 0o000);
          return [
            '--expected-container-id',
            FAKE_CONTAINER_ID,
            '--exec-env-file',
            file,
            'exec',
            'quorum',
          ];
        },
      },
      {
        label: 'exec env file without an expected container id',
        fragment: 'requires --expected-container-id',
        prepare: (harness) => {
          const file = join(harness.root, 'agent.env');
          writeFileSync(file, 'X=1\n');
          return ['--exec-env-file', file, 'exec', 'quorum'];
        },
      },
      {
        label: 'exec env file outside exec',
        fragment: 'only for exec',
        prepare: (harness) => {
          const file = join(harness.root, 'agent.env');
          writeFileSync(file, 'X=1\n');
          return [
            '--expected-container-id',
            FAKE_CONTAINER_ID,
            '--exec-env-file',
            file,
            'status',
          ];
        },
      },
      {
        label: 'expected container id outside exec',
        fragment: 'only for exec',
        prepare: () => ['--expected-container-id', FAKE_CONTAINER_ID, 'status'],
      },
    ];

    for (const { label, fragment, prepare } of cases) {
      const harness = makeHarness();
      // A canonical root: the strict component walk rightly refuses the
      // macOS /var -> /private/var alias mkdtemp hands out.
      harness.root = realpathSync(harness.root);
      try {
        const proc = runWrapper(harness, prepare(harness));

        expect(proc.error).toBeUndefined();
        expect(proc.status).not.toBe(0);
        // Case-specific diagnostics plus exact no-Docker behavior, so an
        // unknown-flag rejection cannot pass this test vacuously.
        expect(proc.stderr).toContain(fragment);
        expect(dockerLogLines(harness.dockerLog)).toEqual([]);
      } catch (error) {
        throw new Error(`case '${label}': ${String(error)}`);
      } finally {
        rmSync(harness.root, { recursive: true, force: true });
      }
    }
  });

  test('--no-default-auth up refuses to discover a repo-default env file', () => {
    const harness = makeHarness();
    // A hostile repo-default env file the legacy path would otherwise
    // silently discover and mount as the credential env.
    const repoDefaultEnv = join(REPO, '.env.container');
    expect(existsSync(repoDefaultEnv)).toBe(false);
    writeFileSync(repoDefaultEnv, 'ANTHROPIC_API_KEY=hostile-repo-default\n');
    removeResultProbeFiles();
    try {
      const superpowersRoot = makeSuperpowersRoot(harness.root);

      const proc = runWrapper(harness, [
        '--superpowers-root',
        superpowersRoot,
        '--no-default-auth',
        'up',
      ]);

      expect(proc.error).toBeUndefined();
      expect(proc.status).not.toBe(0);
      expect(proc.stderr).toContain('--env-file');
      expect(dockerLogLines(harness.dockerLog)).toEqual([]);
    } finally {
      rmSync(repoDefaultEnv, { force: true });
      removeResultProbeFiles();
      rmSync(harness.root, { recursive: true, force: true });
    }
  });

  test('scoped up treats the cidfile as the rollback authority when stdout misbehaves', () => {
    const cases: { label: string; fragment: string; stdout: string }[] = [
      { label: 'blank stdout', fragment: 'no container id', stdout: 'blank' },
      {
        label: 'multi-token stdout',
        fragment: 'multiple tokens',
        stdout: 'multi',
      },
      {
        label: 'name-like stdout',
        fragment: 'malformed',
        stdout: 'name',
      },
    ];
    for (const { label, fragment, stdout } of cases) {
      const harness = makeHarness({ EVALS_CONTAINER_RUN_STDOUT: stdout });
      removeResultProbeFiles();
      try {
        const superpowersRoot = makeSuperpowersRoot(harness.root);
        const envFile = join(harness.root, 'agent.env');
        writeFileSync(envFile, '');

        const proc = runWrapper(harness, [
          '--superpowers-root',
          superpowersRoot,
          '--env-file',
          envFile,
          '--no-default-auth',
          'up',
        ]);

        expect(proc.error).toBeUndefined();
        expect(proc.status).not.toBe(0);
        expect(proc.stderr).toContain(fragment);
        expect(proc.stderr).toContain('rolled back container');
        // Rollback removes exactly the cidfile container id, never the
        // configured name.
        expect(dockerCommandsNamed(harness.dockerLog, 'rm')).toEqual([
          ['rm', '-f', FAKE_CONTAINER_ID],
        ]);
        expect(dockerCommandsNamed(harness.dockerLog, 'stop')).toEqual([]);
      } catch (error) {
        throw new Error(`case '${label}': ${String(error)}`);
      } finally {
        removeResultProbeFiles();
        rmSync(harness.root, { recursive: true, force: true });
      }
    }
  });

  test('scoped up cross-checks stdout against the cidfile and rolls back the cidfile id on mismatch', () => {
    const harness = makeHarness({ EVALS_CONTAINER_RUN_STDOUT: 'mismatch' });
    removeResultProbeFiles();
    try {
      const superpowersRoot = makeSuperpowersRoot(harness.root);
      const envFile = join(harness.root, 'agent.env');
      writeFileSync(envFile, '');

      const proc = runWrapper(harness, [
        '--superpowers-root',
        superpowersRoot,
        '--env-file',
        envFile,
        '--no-default-auth',
        'up',
      ]);

      expect(proc.error).toBeUndefined();
      expect(proc.status).not.toBe(0);
      expect(proc.stderr).toContain('does not match');
      // The cidfile id (the container docker actually created) is the
      // rollback target — not the mismatched stdout id.
      expect(dockerCommandsNamed(harness.dockerLog, 'rm')).toEqual([
        ['rm', '-f', FAKE_CONTAINER_ID],
      ]);
      expect(dockerCommandsNamed(harness.dockerLog, 'stop')).toEqual([]);
    } finally {
      removeResultProbeFiles();
      rmSync(harness.root, { recursive: true, force: true });
    }
  });

  test('a scoped rollback failure is appended to the original failure without masking it', () => {
    const harness = makeHarness({
      EVALS_CONTAINER_RUN_STDOUT: 'blank',
      EVALS_CONTAINER_RM_FAIL: 'true',
    });
    removeResultProbeFiles();
    try {
      const superpowersRoot = makeSuperpowersRoot(harness.root);
      const envFile = join(harness.root, 'agent.env');
      writeFileSync(envFile, '');

      const proc = runWrapper(harness, [
        '--superpowers-root',
        superpowersRoot,
        '--env-file',
        envFile,
        '--no-default-auth',
        'up',
      ]);

      expect(proc.error).toBeUndefined();
      expect(proc.status).not.toBe(0);
      expect(proc.stderr).toContain('no container id');
      expect(proc.stderr).toContain('also failed');
      expect(dockerCommandsNamed(harness.dockerLog, 'rm')).toEqual([
        ['rm', '-f', FAKE_CONTAINER_ID],
      ]);
    } finally {
      removeResultProbeFiles();
      rmSync(harness.root, { recursive: true, force: true });
    }
  });
});
