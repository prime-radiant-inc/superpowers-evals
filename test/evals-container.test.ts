import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const REPO = resolve(import.meta.dir, '..');
const WRAPPER = join(REPO, 'scripts', 'evals-container');

const FAKE_DOCKER = `#!/usr/bin/env bash
set -euo pipefail

python3 -c 'import json,sys; print(json.dumps(sys.argv[1:]))' "$@" >> "$EVALS_CONTAINER_DOCKER_LOG"

state_file="\${EVALS_CONTAINER_DOCKER_STATE:?}"
exists=false
running=false
name=

if [[ -f "$state_file" ]]; then
  # shellcheck disable=SC1090
  source "$state_file"
fi

write_state() {
  {
    printf 'exists=%q\\n' "$exists"
    printf 'running=%q\\n' "$running"
    printf 'name=%q\\n' "$name"
  } > "$state_file"
}

run_name() {
  local expect_name=false
  local arg
  for arg in "$@"; do
    if [[ "$expect_name" == true ]]; then
      printf '%s\\n' "$arg"
      return 0
    fi
    case "$arg" in
      --name)
        expect_name=true
        ;;
      --name=*)
        printf '%s\\n' "\${arg#--name=}"
        return 0
        ;;
    esac
  done
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
      exit 0
    fi

    [[ "\${3:-}" == "$name" ]]
    ;;
  inspect)
    printf 'generic inspect is not supported by this fake docker\\n' >&2
    exit 2
    ;;
  run)
    name="$(run_name "$@")"
    if [[ -z "$name" || "$name" == -* ]]; then
      exit 1
    fi
    exists=true
    running=true
    write_state
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
    if [[ "$exists" != true || "\${2:-}" != "$name" ]]; then
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
      EVALS_CONTAINER_FAKE_RESULTS_HOST_DIR: join(REPO, 'results'),
      GAUNTLET_ROOT: gauntletRoot,
      PATH: `${bin}:${Bun.env['PATH'] ?? ''}`,
    },
  };
}

function writeDockerState(
  harness: ReturnType<typeof makeHarness>,
  state: { exists: boolean; running: boolean; name: string },
): void {
  writeFileSync(
    harness.dockerState,
    [
      `exists=${state.exists ? 'true' : 'false'}`,
      `running=${state.running ? 'true' : 'false'}`,
      `name=${state.name}`,
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
