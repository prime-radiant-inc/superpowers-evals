import { createHash, randomUUID } from 'node:crypto';
import {
  type BigIntStats,
  closeSync,
  constants,
  existsSync,
  fstatSync,
  ftruncateSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  readSync,
  realpathSync,
  statfsSync,
  writeFileSync,
} from 'node:fs';
import { networkInterfaces } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';
import { z } from 'zod';
import {
  type CommandRunner,
  SpawnCommandRunner,
} from '../../../src/agents/command-runner.ts';
import {
  assertPinnedDirectoryNamed,
  closePin,
  type PinnedDir,
  pinAbsoluteDir,
  pinChildDir,
} from '../../../src/appliance/credential-scope.ts';
import { startNativeObserverProvider } from './native-observer-provider.ts';

const absolute = z.string().refine(isAbsolute, 'absolute path required');
const Config = z
  .object({
    runtime: z.enum(['codex', 'claude']),
    binary: absolute,
    expectedVersion: z.string().min(1),
    expectedExecutableSha256: z.string().regex(/^[a-f0-9]{64}$/),
    tmux: absolute,
    path: z
      .string()
      .min(1)
      .refine(
        (p) => p.split(':').every(isAbsolute),
        'explicit absolute PATH required',
      ),
    output: absolute,
    imageId: z.string().regex(/^sha256:[a-f0-9]{64}$/),
    evalsCommit: z.string().regex(/^[a-f0-9]{40}$/),
    gauntletCommit: z.string().regex(/^[a-f0-9]{40}$/),
    expectedBunVersion: z.string().min(1),
    deadlineMs: z.number().int().positive().max(540000),
    startupMs: z.number().int().min(0).max(30000),
  })
  .strict();
export type NativeCaptureConfig = z.infer<typeof Config>;
const inputs = [
  'Please reply with a short text acknowledgment of native capture input one. Do not use tools.',
  'I approve this text-only capture. Please acknowledge native capture input two. Do not use tools.',
];
const replies = [
  'Native capture response one complete.',
  'Native capture response two complete.',
];
const MAX_BYTES = 256 * 1024 * 1024;

function requireCondition(value: unknown, reason: string): asserts value {
  if (!value) throw new Error(reason);
}

/** Namespace checks complement the operator's independent Docker limits. */
export function verifyNativeCaptureBoundary(config: NativeCaptureConfig) {
  requireCondition(
    process.platform === 'linux' && existsSync('/.dockerenv'),
    'disposable Linux Docker container required',
  );
  const interfaces = Object.keys(networkInterfaces());
  requireCondition(
    interfaces.length === 1 && interfaces[0] === 'lo',
    'Docker --network none with loopback only required',
  );
  const routes = readFileSync('/proc/net/route', 'utf8').trim().split('\n');
  requireCondition(routes.length === 1, 'network routes must be absent');
  const rootMount = readFileSync('/proc/mounts', 'utf8')
    .split('\n')
    .map((line) => line.split(' '))
    .find((parts) => parts[1] === '/');
  requireCondition(
    rootMount?.[3]?.split(',').includes('ro'),
    'read-only image root required',
  );
  requireCondition(
    !existsSync('/var/run/docker.sock'),
    'Docker socket must not be mounted',
  );
  requireCondition(
    readFileSync(config.binary)
      .subarray(0, 4)
      .equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46])),
    'select the actual ELF native executable, not a launcher',
  );
  return {
    platform: process.platform,
    interfaces,
    routes,
    rootReadOnly: true,
    nativeExecutableFormat: 'ELF',
  };
}

function digest(path: string) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}
function sameIdentity(before: BigIntStats, after: BigIntStats) {
  return (
    before.dev === after.dev &&
    before.ino === after.ino &&
    before.mode === after.mode
  );
}
function sameFile(before: BigIntStats, after: BigIntStats) {
  return (
    sameIdentity(before, after) &&
    before.isFile() &&
    after.isFile() &&
    before.size === after.size &&
    before.mtimeNs === after.mtimeNs &&
    before.ctimeNs === after.ctimeNs
  );
}

export function inventoryNativeCapture(
  root: string,
  withDigests = true,
  hooks?: {
    beforeOpen?: (path: string) => void;
    afterReadChunk?: (path: string) => void;
    afterReadLink?: (path: string) => void;
  },
) {
  const files: (
    | { path: string; bytes: number; sha256: string }
    | { kind: 'symlink'; path: string; target: string }
  )[] = [];
  let bytes = 0;
  const rootPin = pinAbsoluteDir(root, 'capture root');
  const rootIdentity = fstatSync(rootPin.fd, { bigint: true });
  const visit = (pin: PinnedDir, parts: string[]) => {
    const beforeDirectory = fstatSync(pin.fd, { bigint: true });
    const names = readdirSync(pin.viaPath).sort();
    for (const name of names) {
      const path = join(pin.viaPath, name);
      const relativePath = [...parts, name].join('/');
      const before = lstatSync(path, { bigint: true });
      hooks?.beforeOpen?.(relativePath);
      if (before.isSymbolicLink()) {
        // Native CLIs create launcher links. Preserve their targets as metadata,
        // without opening them or treating them as raw session evidence.
        const target = readlinkSync(path);
        hooks?.afterReadLink?.(relativePath);
        const after = lstatSync(path, { bigint: true });
        requireCondition(
          sameIdentity(before, after) &&
            after.isSymbolicLink() &&
            before.size === after.size &&
            before.mtimeNs === after.mtimeNs &&
            before.ctimeNs === after.ctimeNs,
          'capture symlink changed during read',
        );
        files.push({ kind: 'symlink', path: relativePath, target });
      } else if (before.isDirectory()) {
        const child = pinChildDir(pin, name, 'capture directory')!;
        try {
          requireCondition(
            sameIdentity(before, fstatSync(child.fd, { bigint: true })),
            'capture directory changed before open',
          );
          visit(child, [...parts, name]);
          assertPinnedDirectoryNamed(pin, child, name, 'capture directory');
        } finally {
          closePin(child);
        }
      } else if (before.isFile()) {
        const fd = openSync(
          path,
          constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
        );
        try {
          requireCondition(
            sameFile(before, fstatSync(fd, { bigint: true })),
            'capture file changed before open',
          );
          requireCondition(
            before.size <= BigInt(MAX_BYTES - bytes),
            'capture output limit exceeded',
          );
          let count = 0;
          const hash = createHash('sha256');
          if (withDigests) {
            const buffer = Buffer.alloc(65536);
            while (true) {
              const read = readSync(
                fd,
                buffer,
                0,
                Math.min(buffer.length, MAX_BYTES - bytes - count + 1),
                count,
              );
              if (read === 0) break;
              count += read;
              requireCondition(
                bytes + count <= MAX_BYTES,
                'capture output limit exceeded',
              );
              hash.update(buffer.subarray(0, read));
              hooks?.afterReadChunk?.(relativePath);
              requireCondition(
                sameFile(before, fstatSync(fd, { bigint: true })),
                'capture file changed during read',
              );
            }
            requireCondition(
              BigInt(count) === before.size,
              'capture file byte count changed',
            );
          } else {
            count = Number(before.size);
          }
          requireCondition(
            sameFile(before, fstatSync(fd, { bigint: true })) &&
              sameFile(before, lstatSync(path, { bigint: true })),
            'capture file replaced or changed during read',
          );
          bytes += count;
          files.push({
            path: relativePath,
            bytes: count,
            sha256: withDigests ? hash.digest('hex') : '',
          });
        } finally {
          closeSync(fd);
        }
      } else {
        // A live tmux socket is not raw session evidence.
        requireCondition(
          before.isSocket(),
          `unsupported capture file: ${relativePath}`,
        );
      }
    }
    const afterDirectory = fstatSync(pin.fd, { bigint: true });
    requireCondition(
      sameIdentity(beforeDirectory, afterDirectory) &&
        beforeDirectory.mtimeNs === afterDirectory.mtimeNs &&
        beforeDirectory.ctimeNs === afterDirectory.ctimeNs &&
        JSON.stringify(names) ===
          JSON.stringify(readdirSync(pin.viaPath).sort()),
      'capture directory changed during inventory',
    );
  };
  try {
    visit(rootPin, []);
    // Rewalk every ancestor no-follow and ensure the original root is still named.
    const current = pinAbsoluteDir(root, 'capture root');
    try {
      requireCondition(
        sameIdentity(rootIdentity, fstatSync(current.fd, { bigint: true })),
        'capture root replaced during inventory',
      );
    } finally {
      closePin(current);
    }
    return files;
  } finally {
    closePin(rootPin);
  }
}

export async function captureNativeParent(
  rawConfig: NativeCaptureConfig,
  dependencies: {
    // Tests supply an explicit fake-native boundary; the executable CLI has no bypass.
    verifyBoundary?: (config: NativeCaptureConfig) => unknown;
    inspectStorage?: (path: string) => {
      type: number;
      bsize: number;
      blocks: number;
    };
    providerPort?: number;
    runner?: CommandRunner;
    writeReceipt?: (path: string, body: string) => void;
  } = {},
) {
  const config = Config.parse(rawConfig);
  const boundary = (dependencies.verifyBoundary ?? verifyNativeCaptureBoundary)(
    config,
  );
  requireCondition(
    !existsSync(config.output),
    'output must be a fresh directory',
  );
  requireCondition(
    realpathSync(dirname(config.output)) === dirname(config.output),
    'output parent must be canonical',
  );
  mkdirSync(config.output, { mode: 0o700 });
  const home = join(config.output, 'home');
  const workdir = join(config.output, 'workdir');
  const tmp = join(config.output, 'tmp');
  for (const dir of [
    home,
    workdir,
    tmp,
    join(home, '.codex'),
    join(home, '.claude'),
  ])
    mkdirSync(dir, { mode: 0o700 });
  const initialPin = pinAbsoluteDir(config.output, 'capture output');
  const outputIdentity = fstatSync(initialPin.fd, { bigint: true });
  closePin(initialPin);
  const receiptFailures: { file: string; error: string }[] = [];
  const write = (name: string, data: unknown) => {
    const body = `${JSON.stringify(data, null, 2)}\n`;
    try {
      const pin = pinAbsoluteDir(config.output, 'capture output');
      try {
        requireCondition(
          sameIdentity(outputIdentity, fstatSync(pin.fd, { bigint: true })),
          'capture output root replaced',
        );
        const path = join(pin.viaPath, name);
        if (dependencies.writeReceipt)
          dependencies.writeReceipt(join(config.output, name), body);
        else {
          const fd = openSync(
            path,
            constants.O_WRONLY |
              constants.O_CREAT |
              constants.O_NOFOLLOW |
              constants.O_NONBLOCK,
            0o600,
          );
          try {
            requireCondition(
              fstatSync(fd).isFile(),
              'receipt must be a regular file',
            );
            ftruncateSync(fd, 0);
            writeFileSync(fd, body);
            requireCondition(
              sameIdentity(
                fstatSync(fd, { bigint: true }),
                lstatSync(path, { bigint: true }),
              ),
              'receipt replaced during write',
            );
          } finally {
            closeSync(fd);
          }
        }
      } finally {
        closePin(pin);
      }
    } catch (error) {
      receiptFailures.push({
        file: name,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  };
  const env: Record<string, string> = {
    PATH: config.path,
    TERM: 'xterm-256color',
    HOME: home,
    XDG_CONFIG_HOME: join(home, '.config'),
    XDG_CACHE_HOME: join(home, '.cache'),
    XDG_STATE_HOME: join(home, '.local/state'),
    TMPDIR: tmp,
    TMUX_TMPDIR: tmp,
  };
  const runner = dependencies.runner ?? new SpawnCommandRunner();
  const started = Date.now();
  const deadline = started + config.deadlineMs;
  const run = (command: string, args: string[], cleanup = false) => {
    const remaining = cleanup ? 2000 : Math.min(5000, deadline - Date.now());
    requireCondition(remaining > 0, 'capture deadline exceeded');
    return runner.run(command, args, {
      env,
      cwd: workdir,
      timeoutMs: remaining,
    });
  };
  const socket = join(config.output, 't');
  const session = `capture-${randomUUID().slice(0, 8)}`;
  const tmux = (args: string[], cleanup = false) =>
    run(config.tmux, ['-S', socket, '-f', '/dev/null', ...args], cleanup);
  let provider: ReturnType<typeof startNativeObserverProvider> | undefined;
  let launched = false;
  let outcome: 'captured' | 'refused' = 'refused';
  let reason: string | undefined;
  const errors: string[] = [];
  const refuse = (error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    outcome = 'refused';
    reason ??= message;
    errors.push(message);
  };
  const attempt = <T>(action: () => T): T | undefined => {
    try {
      return action();
    } catch (error) {
      refuse(error);
      return undefined;
    }
  };
  const safeWrite = (name: string, data: unknown) =>
    attempt(() => write(name, data));
  let cleanup = 'not-started';
  let identity:
    | {
        executable: { path: string; sha256: string };
        version: string;
        help: string;
        bunVersion: string;
        tmux: { path: string; sha256: string };
      }
    | undefined;
  const inputLedger: { text: string; submittedAt: string; method: string }[] =
    [];
  let files: ReturnType<typeof inventoryNativeCapture> = [];
  const persist = () => {
    write('requests.json', provider?.records ?? []);
    write('inputs.json', inputLedger);
  };
  const checkStorage = () => {
    const storage = (dependencies.inspectStorage ?? statfsSync)(config.output);
    const capacity = storage.bsize * storage.blocks;
    requireCondition(
      storage.type === 0x01021994 &&
        Number.isSafeInteger(capacity) &&
        capacity > 0 &&
        capacity <= MAX_BYTES,
      'capture storage must be tmpfs bounded to 256 MiB',
    );
    return { type: storage.type, capacityBytes: capacity };
  };
  const guard = () => {
    persist();
    requireCondition(Date.now() < deadline, 'capture deadline exceeded');
    const refusal = provider?.records.find(
      (record) =>
        record.decision !== 'accepted' && record.decision !== 'health-check',
    );
    requireCondition(!refusal, `provider refusal: ${refusal?.decision}`);
    // The native CLI is actively writing. Its enforced tmpfs capacity bounds
    // live storage; stable nofollow evidence is inventoried only after teardown.
    checkStorage();
  };
  const pause = async (ms: number) => {
    guard();
    await Bun.sleep(Math.min(ms, Math.max(0, deadline - Date.now())));
    guard();
  };
  const screen = () => {
    const result = tmux(['capture-pane', '-t', session, '-p', '-S', '-2000']);
    requireCondition(
      result.status === 0,
      `TUI capture failed: ${result.stderr}`,
    );
    write('screen.json', { at: new Date().toISOString(), text: result.stdout });
    return result.stdout;
  };
  try {
    write('config.json', config);
    write('boundary.json', boundary);
    write('storage.json', checkStorage());
    requireCondition(
      config.expectedBunVersion === Bun.version,
      'Bun version mismatch',
    );
    for (const path of [config.binary, config.tmux])
      requireCondition(
        realpathSync(path) === path && lstatSync(path).isFile(),
        'executable path must resolve to the selected regular file',
      );
    const executable = { path: config.binary, sha256: digest(config.binary) };
    write('executable.json', executable);
    requireCondition(
      executable.sha256 === config.expectedExecutableSha256,
      'native executable digest mismatch',
    );
    write(
      'source-files.json',
      [
        import.meta.path,
        join(import.meta.dir, 'native-observer-provider.ts'),
        join(import.meta.dir, '../../../src/agents/command-runner.ts'),
      ].map((path) => ({ path, sha256: digest(path) })),
    );
    const version = run(config.binary, ['--version']);
    const help = run(config.binary, ['--help']);
    identity = {
      executable,
      version: version.stdout.trim(),
      help: help.stdout,
      bunVersion: Bun.version,
      tmux: { path: config.tmux, sha256: digest(config.tmux) },
    };
    write('identity.json', {
      ...identity,
      helpSha256: createHash('sha256').update(help.stdout).digest('hex'),
      bunExecutable: {
        path: realpathSync(process.execPath),
        sha256: digest(process.execPath),
      },
      launchMode:
        'direct native ELF interactive TUI; wrapper environment absent',
    });
    requireCondition(
      version.status === 0 && identity.version === config.expectedVersion,
      'native executable version mismatch',
    );
    const flags =
      config.runtime === 'codex'
        ? ['--no-alt-screen', '--sandbox', '--ask-for-approval']
        : [
            '--model',
            '--permission-mode',
            '--strict-mcp-config',
            '--setting-sources',
          ];
    requireCondition(
      help.status === 0 && flags.every((flag) => help.stdout.includes(flag)),
      'selected native help lacks required launch flags',
    );
    const protocol = config.runtime === 'codex' ? 'responses' : 'messages';
    const model = config.runtime === 'codex' ? 'gpt-6-astra' : 'claude-opus-5';
    provider = startNativeObserverProvider({
      port: dependencies.providerPort ?? 43871,
      maxRequests: 4,
      steps: inputs.map((text, index) => ({
        protocol,
        request: (request) => {
          const conversation =
            request[protocol === 'responses' ? 'input' : 'messages'];
          if (request['model'] !== model || !Array.isArray(conversation))
            return false;
          const users = conversation.filter(
            (item) => item && typeof item === 'object' && item.role === 'user',
          );
          const last = users.at(-1);
          if (!last) return false;
          const content = last.content;
          return (
            content === text ||
            (Array.isArray(content) &&
              content.some(
                (block) =>
                  block &&
                  typeof block === 'object' &&
                  ['text', 'input_text'].includes(block.type) &&
                  block.text === text,
              ))
          );
        },
        blocks: [{ type: 'text', text: replies[index]! }],
      })),
    });
    const endpoint = provider.url.origin;
    let argv: string[];
    if (config.runtime === 'codex') {
      env['CODEX_HOME'] = join(home, '.codex');
      env['CODEX_PROVIDER_API_KEY'] = 'native-capture-fake';
      writeFileSync(
        join(home, '.codex/config.toml'),
        `[projects.${JSON.stringify(workdir)}]\ntrust_level = "trusted"\n`,
        { mode: 0o600, flag: 'wx' },
      );
      argv = [
        '-C',
        workdir,
        '--no-alt-screen',
        '--sandbox',
        'workspace-write',
        '--ask-for-approval',
        'never',
        ...[
          `model="${model}"`,
          'model_provider="quorum"',
          'model_providers.quorum.name="quorum"',
          `model_providers.quorum.base_url="${endpoint}/v1"`,
          'model_providers.quorum.env_key="CODEX_PROVIDER_API_KEY"',
          'model_providers.quorum.wire_api="responses"',
        ].flatMap((value) => ['-c', value]),
      ];
    } else {
      env['ANTHROPIC_API_KEY'] = 'native-capture-fake';
      env['ANTHROPIC_BASE_URL'] = endpoint;
      // The existing Claude adapter seeds project trust and the literal key's approval suffix.
      writeFileSync(
        join(home, '.claude.json'),
        JSON.stringify({
          // Capture-only hypothesis for the pinned CLI's first-run screens.
          // A native fake-key run must still prove authenticated model turns;
          // this does not assert parity with the production API-key adapter.
          hasCompletedOnboarding: true,
          theme: 'dark',
          projects: {
            [workdir]: {
              hasTrustDialogAccepted: true,
              projectOnboardingSeenCount: 1,
              hasClaudeMdExternalIncludesApproved: true,
              hasClaudeMdExternalIncludesWarningShown: true,
            },
          },
          customApiKeyResponses: {
            approved: ['native-capture-fake'.slice(-20)],
            rejected: [],
          },
        }),
        { mode: 0o600 },
      );
      argv = [
        '--model',
        model,
        '--permission-mode',
        'dontAsk',
        '--strict-mcp-config',
        '--setting-sources',
        '',
      ];
    }
    write('launch.json', {
      binary: config.binary,
      argv,
      env,
      workdir,
      socket,
      session,
    });
    launched = true;
    const launch = tmux([
      'new-session',
      '-d',
      '-s',
      session,
      '-x',
      '160',
      '-y',
      '48',
      '-c',
      workdir,
      config.binary,
      ...argv,
    ]);
    requireCondition(
      launch.status === 0,
      `native TUI launch failed: ${launch.stderr}`,
    );
    await pause(config.startupMs);
    screen();
    for (const [index, text] of inputs.entries()) {
      requireCondition(
        tmux(['send-keys', '-t', session, '-l', text]).status === 0,
        'TUI typing failed',
      );
      // Gauntlet's TUI typeAndSubmit uses a render-cycle delay before Enter.
      await pause(15);
      requireCondition(
        tmux(['send-keys', '-t', session, 'Enter']).status === 0,
        'TUI submission failed',
      );
      inputLedger.push({
        text,
        submittedAt: new Date().toISOString(),
        method: 'tmux literal text then Enter',
      });
      while (true) {
        await pause(100);
        const text = screen();
        if (
          provider.records.filter((record) => record.decision === 'accepted')
            .length ===
            index + 1 &&
          text.includes(replies[index]!)
        )
          break;
      }
    }
    await pause(250);
    outcome = 'captured';
  } catch (error) {
    refuse(Date.now() >= deadline ? 'capture deadline exceeded' : error);
  } finally {
    if (launched) {
      const last = attempt(() =>
        tmux(['capture-pane', '-t', session, '-p', '-S', '-2000'], true),
      );
      if (last) safeWrite('final-screen.json', last);
      // Each stop/verification command runs even if screen capture or storage fails.
      attempt(() => tmux(['send-keys', '-t', session, 'C-c'], true));
      await Bun.sleep(100);
      const killed = attempt(() => tmux(['kill-server'], true));
      const absent = attempt(() => tmux(['list-sessions'], true));
      cleanup =
        absent?.status === 1 &&
        (killed?.status === 0 ||
          /no server running|no such file/i.test(killed?.stderr ?? ''))
          ? 'stopped'
          : 'unconfirmed';
      safeWrite('cleanup.json', { killed, absent });
    }
    try {
      if (provider) await provider.stop();
    } catch (error) {
      refuse(error);
    }
    safeWrite('requests.json', provider?.records ?? []);
    safeWrite('inputs.json', inputLedger);
    const refusedRequest = provider?.records.find(
      (record) =>
        record.decision !== 'accepted' && record.decision !== 'health-check',
    );
    if (refusedRequest) refuse(`provider refusal: ${refusedRequest.decision}`);
    const observed = attempt(() => inventoryNativeCapture(config.output));
    if (observed) files = observed;
    if (
      outcome === 'captured' &&
      !files.some(
        (file) =>
          'bytes' in file &&
          file.path.startsWith('home/') &&
          file.path.endsWith('.jsonl') &&
          file.bytes > 0,
      )
    )
      refuse('no raw native session files captured');
    if (launched && cleanup !== 'stopped') refuse('cleanup unconfirmed');
  }
  const result = {
    outcome,
    reason,
    cleanup,
    receiptFailures,
    errors,
    identity,
    files,
    startedAt: new Date(started).toISOString(),
    stoppedAt: new Date().toISOString(),
    qualification:
      'unqualified; inspect native provenance and grammar separately',
  };
  safeWrite('capture-result.json', result);
  result.outcome = outcome;
  result.reason = reason;
  return result;
}

if (import.meta.main) {
  try {
    requireCondition(
      process.argv.length === 3,
      'usage: bun native-observer-capture.ts /absolute/capture-config.json',
    );
    const configPath = process.argv[2]!;
    requireCondition(isAbsolute(configPath), 'absolute config path required');
    const result = await captureNativeParent(
      JSON.parse(readFileSync(configPath, 'utf8')),
    );
    process.stdout.write(
      `${JSON.stringify({
        outcome: result.outcome,
        reason: result.reason,
        cleanup: result.cleanup,
        receiptFailures: result.receiptFailures,
        errors: result.errors,
      })}\n`,
    );
    if (result.outcome !== 'captured') process.exitCode = 1;
  } catch (error) {
    process.stderr.write(
      `${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  }
}
