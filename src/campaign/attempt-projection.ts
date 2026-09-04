import { fchmodSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  assertDistinctFromGraderAuth,
  assertPinnedDirectoryNamed,
  buildSupervisorEnv,
  COPILOT_SUPERVISOR_ENV_NAMES,
  closePin,
  createAndPinChild,
  GRADER_SOURCE_ENV_BY_RUNTIME_NAME,
  pinAbsoluteDir,
  pinChildDir,
  readBundleEnvForProjection,
  removePinnedDirectory,
  SUPERVISOR_NETWORK_ENV_NAMES,
  selectAgentEnv,
  writePinnedFile,
} from '../appliance/credential-scope.ts';
import { type Grader, GraderSchema } from '../contracts/campaign/experiment.ts';
import { loadCredentialsFile, mantleBaseUrl } from '../credentials/index.ts';
import { resolveCredentialSelection } from '../credentials/scope.ts';

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
  readonly grader?: Grader;
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

function cleanupAfterFailure(
  attemptPin: Parameters<typeof removePinnedDirectory>[0],
  stagePin: Parameters<typeof removePinnedDirectory>[1],
  attemptId: string,
): void {
  try {
    if (!removePinnedDirectory(attemptPin, stagePin)) {
      throw refuse(attemptId, 'credential stage survived cleanup');
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

  const resolved = (() => {
    try {
      return resolveCredentialSelection(args.evalsRoot, {
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
  const scope = resolved.scope;
  const selectedGrader =
    args.grader === undefined
      ? undefined
      : (() => {
          const grader = GraderSchema.parse(args.grader);
          const credential = loadCredentialsFile(
            join(args.evalsRoot, 'credentials.yaml'),
          ).credentials[grader.credential];
          if (credential === undefined || credential.model !== grader.model)
            throw refuse(
              args.attemptId,
              'selected grader credential/model mismatch',
            );
          if (
            !(
              (credential.api === 'anthropic' &&
                credential.auth === 'api-key') ||
              (credential.api === 'mantle' &&
                credential.auth === 'bedrock-bearer')
            ) ||
            credential.key_pool !== undefined
          )
            throw refuse(
              args.attemptId,
              'unsupported grader credential projection',
            );
          if (credential.api_key_env === undefined)
            throw refuse(
              args.attemptId,
              'grader credential requires exact api_key_env',
            );
          return credential;
        })();
  if (resolved.auth !== 'api-key' && resolved.auth !== 'bedrock-bearer') {
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
  if (selectedGrader?.api_key_env !== undefined)
    names.add(selectedGrader.api_key_env);
  // This is the same complete source set used by Phase 1 staging: grader
  // aliases plus routing/TLS names and Copilot-specific routing aliases.
  for (const name of Object.values(GRADER_SOURCE_ENV_BY_RUNTIME_NAME)) {
    names.add(name);
  }
  for (const name of SUPERVISOR_NETWORK_ENV_NAMES) names.add(name);
  for (const name of COPILOT_SUPERVISOR_ENV_NAMES) names.add(name);

  let bundleEnv: ReadonlyMap<string, string>;
  let attemptPin: ReturnType<typeof pinAbsoluteDir> | null = null;
  let stagePin: ReturnType<typeof pinAbsoluteDir> | null = null;
  try {
    bundleEnv = readBundleEnvForProjection(args.bundleDir, [...names]);
    const agent = selectAgentEnv(scope, bundleEnv);
    const supervisor =
      selectedGrader === undefined
        ? buildSupervisorEnv(scope, bundleEnv)
        : (() => {
            const value = bundleEnv.get(selectedGrader.api_key_env ?? '');
            if (value === undefined || value === '')
              throw refuse(args.attemptId, 'selected grader secret is missing');
            const lines = [
              'QUORUM_GRADER_SOURCE_MODE=appliance-scoped',
              `QUORUM_GRADER_ANTHROPIC_API_KEY=${value}`,
            ];
            const baseUrl =
              selectedGrader.api === 'mantle'
                ? mantleBaseUrl(selectedGrader.region ?? '')
                : selectedGrader.base_url;
            if (selectedGrader.api === 'mantle' && !selectedGrader.region)
              throw refuse(args.attemptId, 'grader region is missing');
            if (baseUrl !== undefined)
              lines.push(`QUORUM_GRADER_ANTHROPIC_BASE_URL=${baseUrl}`);
            for (const name of SUPERVISOR_NETWORK_ENV_NAMES) {
              const routing = bundleEnv.get(name);
              if (routing !== undefined) lines.push(`${name}=${routing}`);
            }
            return { lines, graderAuthValues: [value] };
          })();
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

    const campaignPin = pinAbsoluteDir(args.campaignDir, 'campaign directory');
    let attemptsPin: ReturnType<typeof pinAbsoluteDir> | null = null;
    let homePin: ReturnType<typeof pinAbsoluteDir> | null = null;
    let stagingPin: ReturnType<typeof pinAbsoluteDir> | null = null;
    try {
      attemptsPin = createAndPinChild(
        campaignPin,
        'attempts',
        'campaign attempts',
      );
      attemptPin = createAndPinChild(
        attemptsPin,
        args.attemptId,
        'attempt directory',
      );
      homePin = createAndPinChild(attemptPin, 'home', 'attempt home');
      stagingPin = createAndPinChild(attemptPin, 'staging', 'attempt staging');
      stagePin = createAndPinChild(
        attemptPin,
        '.stage',
        'attempt credential stage',
      );
    } finally {
      closePin(campaignPin);
      if (attemptsPin !== null) closePin(attemptsPin);
      if (homePin !== null) closePin(homePin);
      if (stagingPin !== null) closePin(stagingPin);
    }

    if (attemptPin === null || stagePin === null) {
      throw refuse(args.attemptId, 'credential stage could not be pinned');
    }
    fchmodSync(stagePin.fd, 0o700);
    const entries = readdirSync(stagePin.viaPath);
    for (const entry of entries) {
      if (!STAGE_ENTRIES.has(entry)) {
        throw refuse(
          args.attemptId,
          'credential stage contains an unexpected entry',
        );
      }
    }
    writePinnedFile(
      stagePin,
      ['subject.env'],
      `${agent.entries.map(([name, value]) => `${name}=${value}`).join('\n')}\n`,
      'subject env',
      0o400,
    );
    writePinnedFile(
      stagePin,
      ['grader.env'],
      `${supervisor.lines.join('\n')}\n`,
      'grader env',
      0o400,
    );
    writePinnedFile(
      stagePin,
      ['passwd'],
      `root:x:0:0:root:/root:/bin/bash\nquorum:x:${args.uid}:${args.gid}:Quorum Attempt:${homeDir}:/bin/bash\n`,
      'passwd',
      0o644,
    );
    writePinnedFile(
      stagePin,
      ['group'],
      `root:x:0:\nquorum:x:${args.gid}:\n`,
      'group',
      0o644,
    );

    assertPinnedDirectoryNamed(
      attemptPin,
      stagePin,
      '.stage',
      'attempt credential stage',
    );

    closePin(stagePin);
    closePin(attemptPin);
    stagePin = null;
    attemptPin = null;

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
    if (attemptPin === null || stagePin === null) {
      if (stagePin !== null) closePin(stagePin);
      if (attemptPin !== null) closePin(attemptPin);
      if (error instanceof AttemptProjectionError) throw error;
      throw refuse(
        args.attemptId,
        error instanceof Error
          ? error.message
          : 'credential projection refused',
      );
    }
    if (attemptPin !== null && stagePin !== null) {
      cleanupAfterFailure(attemptPin, stagePin, args.attemptId);
    }
    if (stagePin !== null) closePin(stagePin);
    if (attemptPin !== null) closePin(attemptPin);
    if (error instanceof AttemptProjectionError) throw error;
    throw refuse(
      args.attemptId,
      `credential projection failed (${error instanceof Error ? error.message : 'unknown error'})`,
    );
  }
}

/** Remove only one attempt's credential stage and verify that it is gone. */
export function removeAttemptStage(attemptDir: string): void {
  let attemptPin: ReturnType<typeof pinAbsoluteDir> | null = null;
  let stagePin: ReturnType<typeof pinAbsoluteDir> | null = null;
  try {
    attemptPin = pinAbsoluteDir(attemptDir, 'attempt directory');
    stagePin = pinChildDir(
      attemptPin,
      '.stage',
      'attempt credential stage',
      false,
    );
    if (stagePin !== null && !removePinnedDirectory(attemptPin, stagePin)) {
      throw new AttemptProjectionError(
        'attempt credential stage survived cleanup',
      );
    }
  } catch {
    throw new AttemptProjectionError('attempt credential stage cleanup failed');
  } finally {
    if (stagePin !== null) closePin(stagePin);
    if (attemptPin !== null) closePin(attemptPin);
  }
}
