import {
  chmodSync,
  lstatSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import {
  assertDistinctFromGraderAuth,
  buildSupervisorEnv,
  COPILOT_SUPERVISOR_ENV_NAMES,
  GRADER_SOURCE_ENV_BY_RUNTIME_NAME,
  readBundleEnvForProjection,
  SUPERVISOR_NETWORK_ENV_NAMES,
  selectAgentEnv,
} from '../appliance/credential-scope.ts';
import {
  assertRealDirNoFollow,
  ensurePrivateDirNoFollow,
} from '../appliance/safe-fs.ts';
import { credentialScopeForSelection } from '../credentials/scope.ts';

export class AttemptProjectionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AttemptProjectionError';
  }
}

export interface PreparedAttemptStage {
  readonly attemptId: string;
  readonly attemptDir: string;
  readonly stageDir: string;
  readonly subjectEnvFile: string;
  readonly graderEnvFile: string;
  readonly homeDir: string;
  readonly stdoutLog: string;
  readonly stderrLog: string;
  readonly stagingDir: string;
  readonly passwdFile: string;
  readonly groupFile: string;
}

export interface PrepareAttemptStageArgs {
  readonly campaignDir: string;
  readonly attemptId: string;
  readonly agent: string;
  readonly credentialName: string;
  readonly evalsRoot: string;
  readonly bundleDir: string;
  readonly uid: number;
  readonly gid: number;
}

const STAGE_ENTRIES = new Set(['subject.env', 'grader.env', 'passwd', 'group']);

function refuse(attemptId: string, detail: string): AttemptProjectionError {
  return new AttemptProjectionError(`attempt ${attemptId}: ${detail}`);
}

function assertAttemptId(attemptId: string): void {
  if (
    attemptId === '' ||
    attemptId === '.' ||
    attemptId === '..' ||
    attemptId.includes('/') ||
    attemptId.includes('\\') ||
    attemptId.includes('\0') ||
    // Attempt IDs are also carried in diagnostics and container labels; keep
    // line/control separators out of both channels.
    // biome-ignore lint/suspicious/noControlCharactersInRegex: reject control separators in attempt identities
    /[\u0001-\u001f\u007f\u0080-\u009f]/.test(attemptId)
  ) {
    throw refuse(attemptId, 'attempt id is not a safe path component');
  }
}

function safeEnvValue(value: string, label: string, attemptId: string): void {
  // These files are consumed as line-delimited environment material. Keep
  // the subject side aligned with the supervisor serializer's CR/LF guard and
  // reject all C0 controls so a credential cannot become a second directive.
  // biome-ignore lint/suspicious/noControlCharactersInRegex: reject all C0/C1 controls in line-delimited env values
  if (/[\u0000-\u001f\u007f\u0080-\u009f]/.test(value)) {
    throw refuse(attemptId, `${label} contains control characters`);
  }
}

function writePrivateFile(
  path: string,
  body: string,
  mode: number,
  attemptId: string,
): void {
  try {
    writeFileSync(path, body, { flag: 'wx', mode });
    chmodSync(path, mode);
  } catch (error) {
    throw refuse(
      attemptId,
      `credential stage file could not be written (${(error as NodeJS.ErrnoException).code ?? 'unknown error'})`,
    );
  }
}

function cleanupAfterFailure(stageDir: string, attemptId: string): void {
  try {
    const stats = lstatSync(stageDir, { throwIfNoEntry: false });
    if (stats !== undefined) {
      // rmSync does not follow a symlink at its root. The no-follow check
      // keeps a concurrently replaced directory from becoming a cleanup
      // target outside this attempt's stage.
      if (stats.isSymbolicLink() || !stats.isDirectory()) {
        throw refuse(attemptId, 'credential stage became a non-directory');
      }
      rmSync(stageDir, { recursive: true, force: true });
      if (lstatSync(stageDir, { throwIfNoEntry: false }) !== undefined) {
        throw refuse(attemptId, 'credential stage survived cleanup');
      }
    }
  } catch (error) {
    if (error instanceof AttemptProjectionError) throw error;
    throw refuse(attemptId, 'credential stage cleanup failed');
  }
}

/**
 * Resolve one frozen subject credential and project only its selected
 * material plus the complete Phase 1 grader/supervisor alias set. All bundle
 * reads and equality checks happen before the first campaign-directory write.
 */
export function prepareAttemptStage(
  args: PrepareAttemptStageArgs,
): PreparedAttemptStage {
  assertAttemptId(args.attemptId);

  const scope = (() => {
    try {
      return credentialScopeForSelection(args.evalsRoot, {
        agent: args.agent,
        credential: args.credentialName,
      });
    } catch (error) {
      throw refuse(
        args.attemptId,
        `credential scope refused (${error instanceof Error ? error.message : 'unknown error'})`,
      );
    }
  })();
  if (scope.oauth !== null) {
    throw refuse(
      args.attemptId,
      `credential '${scope.credential}' requires an OAuth home projection — V2 accepts only api-key and bedrock-bearer deliveries`,
    );
  }
  if (
    scope.agentEnv.some(
      (projection) =>
        projection.destinationName === 'CLAUDE_CODE_OAUTH_TOKEN' ||
        projection.destinationName === 'COPILOT_GITHUB_TOKEN',
    )
  ) {
    throw refuse(
      args.attemptId,
      `credential '${scope.credential}' requires an OAuth home projection — V2 accepts only api-key and bedrock-bearer deliveries`,
    );
  }

  const names = new Set<string>();
  for (const projection of scope.agentEnv) {
    for (const source of projection.sourceNames) names.add(source);
  }
  names.add('GEMINI_AUTH_TYPE');
  // This is the same complete source set used by Phase 1 staging: grader
  // aliases plus routing/TLS names and Copilot-specific routing aliases.
  for (const name of Object.values(GRADER_SOURCE_ENV_BY_RUNTIME_NAME)) {
    names.add(name);
  }
  for (const name of SUPERVISOR_NETWORK_ENV_NAMES) names.add(name);
  for (const name of COPILOT_SUPERVISOR_ENV_NAMES) names.add(name);

  let bundleEnv: ReadonlyMap<string, string>;
  let stageStarted = false;
  try {
    bundleEnv = readBundleEnvForProjection(args.bundleDir, [...names]);
    const agent = selectAgentEnv(scope, bundleEnv);
    const supervisor = buildSupervisorEnv(scope, bundleEnv);
    // Base URLs and routing values are not authentication secrets. The
    // shared helper compares every selected subject secret to every grader
    // authentication value in memory, before any stage directory exists.
    assertDistinctFromGraderAuth(agent.secrets, supervisor.graderAuthValues);

    for (const [name, value] of agent.entries) {
      safeEnvValue(value, `subject env ${name}`, args.attemptId);
    }
    for (const line of supervisor.lines) {
      const eq = line.indexOf('=');
      safeEnvValue(line.slice(eq + 1), 'grader env value', args.attemptId);
    }

    const attemptDir = join(args.campaignDir, 'attempts', args.attemptId);
    const stageDir = join(attemptDir, '.stage');
    const homeDir = join(attemptDir, 'home');
    const stagingDir = join(attemptDir, 'staging');
    const subjectEnvFile = join(stageDir, 'subject.env');
    const graderEnvFile = join(stageDir, 'grader.env');
    const passwdFile = join(stageDir, 'passwd');
    const groupFile = join(stageDir, 'group');

    assertRealDirNoFollow(args.campaignDir, 'campaign directory');
    ensurePrivateDirNoFollow(
      args.campaignDir,
      join(args.campaignDir, 'attempts'),
      'campaign attempts',
    );
    ensurePrivateDirNoFollow(
      join(args.campaignDir, 'attempts'),
      attemptDir,
      'attempt directory',
    );
    ensurePrivateDirNoFollow(attemptDir, homeDir, 'attempt home');
    ensurePrivateDirNoFollow(attemptDir, stagingDir, 'attempt staging');
    ensurePrivateDirNoFollow(attemptDir, stageDir, 'attempt credential stage');
    stageStarted = true;

    const entries = readdirSync(stageDir);
    for (const entry of entries) {
      if (!STAGE_ENTRIES.has(entry)) {
        throw refuse(
          args.attemptId,
          'credential stage contains an unexpected entry',
        );
      }
    }
    chmodSync(stageDir, 0o700);
    writePrivateFile(
      subjectEnvFile,
      agent.entries.map(([name, value]) => `${name}=${value}`).join('\n') +
        '\n',
      0o400,
      args.attemptId,
    );
    writePrivateFile(
      graderEnvFile,
      `${supervisor.lines.join('\n')}\n`,
      0o400,
      args.attemptId,
    );
    writePrivateFile(
      passwdFile,
      `root:x:0:0:root:/root:/bin/bash\nquorum:x:${args.uid}:${args.gid}:Quorum Attempt:${homeDir}:/bin/bash\n`,
      0o644,
      args.attemptId,
    );
    writePrivateFile(
      groupFile,
      `root:x:0:\nquorum:x:${args.gid}:\n`,
      0o644,
      args.attemptId,
    );

    return {
      attemptId: args.attemptId,
      attemptDir,
      stageDir,
      subjectEnvFile,
      graderEnvFile,
      homeDir,
      stdoutLog: join(attemptDir, 'stdout.log'),
      stderrLog: join(attemptDir, 'stderr.log'),
      stagingDir,
      passwdFile,
      groupFile,
    };
  } catch (error) {
    // The scope/equality phase has not created anything. Once filesystem
    // setup begins, remove only this attempt's exact stage on partial writes.
    const attemptDir = join(args.campaignDir, 'attempts', args.attemptId);
    const stageDir = join(attemptDir, '.stage');
    if (!stageStarted) {
      if (error instanceof AttemptProjectionError) throw error;
      throw refuse(
        args.attemptId,
        error instanceof Error
          ? error.message
          : 'credential projection refused',
      );
    }
    cleanupAfterFailure(stageDir, args.attemptId);
    if (error instanceof AttemptProjectionError) throw error;
    throw refuse(
      args.attemptId,
      `credential projection failed (${error instanceof Error ? error.message : 'unknown error'})`,
    );
  }
}

/** Remove only one attempt's credential stage and verify that it is gone. */
export function removeAttemptStage(attemptDir: string): void {
  const stageDir = join(attemptDir, '.stage');
  try {
    assertRealDirNoFollow(attemptDir, 'attempt directory');
    rmSync(stageDir, { recursive: true, force: true });
  } catch {
    throw new AttemptProjectionError('attempt credential stage cleanup failed');
  }
  if (lstatSync(stageDir, { throwIfNoEntry: false }) !== undefined) {
    throw new AttemptProjectionError(
      'attempt credential stage survived cleanup',
    );
  }
}
