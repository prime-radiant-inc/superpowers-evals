import { expect, test } from 'bun:test';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  AttemptProjectionError,
  prepareAttemptStage,
  removeAttemptStage,
} from '../src/campaign/attempt-projection.ts';

const SUBJECT = 'subject-secret-value';
const GRADER = 'grader-secret-value';

function projectionFixture(opts: { sharedSecret?: boolean } = {}) {
  const corpus = realpathSync(
    mkdtempSync(join(tmpdir(), 'projection-corpus-')),
  );
  const campaignDir = realpathSync(
    mkdtempSync(join(tmpdir(), 'projection-camp-')),
  );
  const bundleDir = realpathSync(
    mkdtempSync(join(tmpdir(), 'projection-bundle-')),
  );
  mkdirSync(join(corpus, 'coding-agents'), { recursive: true });
  writeFileSync(
    join(corpus, 'coding-agents', 'claude.yaml'),
    [
      'name: claude',
      'runtime_family: claude',
      'binary: claude',
      'session_log_dir: .',
      "session_log_glob: '*'",
      'normalizer: claude',
      'home_config_subdir: .claude',
      'default_credential: cred_a',
    ].join('\n'),
  );
  writeFileSync(
    join(corpus, 'credentials.yaml'),
    `${[
      'cred_a:',
      '  model: claude-opus-5',
      '  api: anthropic',
      '  auth: api-key',
      '  api_key_env: SUBJECT_KEY',
      '  harnesses: [claude]',
    ].join('\n')}\n`,
  );
  const grader = opts.sharedSecret === true ? SUBJECT : GRADER;
  writeFileSync(
    join(bundleDir, 'credentials.env'),
    `SUBJECT_KEY=${SUBJECT}\nQUORUM_GRADER_ANTHROPIC_API_KEY=${grader}\nQUORUM_GRADER_SOURCE_MODE=appliance-scoped\n`,
  );
  return { corpus, campaignDir, bundleDir, subject: SUBJECT, grader: GRADER };
}

function stage(fx: ReturnType<typeof projectionFixture>, attemptId = 'a') {
  return prepareAttemptStage({
    campaignDir: fx.campaignDir,
    attemptId,
    agent: 'claude',
    credentialName: 'cred_a',
    evalsRoot: fx.corpus,
    bundleDir: fx.bundleDir,
    uid: 1000,
    gid: 1000,
  });
}

test('projection writes exact private files and synthesized identity files', () => {
  const fx = projectionFixture();
  const prepared = stage(fx, 'c1:s:arm_a:r1:a1');
  expect(readFileSync(prepared.subjectEnvFile, 'utf8')).toBe(
    `SUBJECT_KEY=${fx.subject}\n`,
  );
  const graderBody = readFileSync(prepared.graderEnvFile, 'utf8');
  expect(graderBody).toContain('QUORUM_GRADER_SOURCE_MODE=appliance-scoped');
  expect(graderBody).toContain(`QUORUM_GRADER_ANTHROPIC_API_KEY=${fx.grader}`);
  expect(statSync(prepared.subjectEnvFile).mode & 0o777).toBe(0o400);
  expect(statSync(prepared.graderEnvFile).mode & 0o777).toBe(0o400);
  expect(statSync(prepared.stageDir).mode & 0o777).toBe(0o700);
  expect(existsSync(join(prepared.attemptDir, 'staging'))).toBe(true);
  expect(existsSync(join(prepared.attemptDir, 'home'))).toBe(true);
  expect(readFileSync(prepared.passwdFile, 'utf8')).toContain(
    `quorum:x:1000:1000:Quorum Attempt:${prepared.homeDir}:/bin/bash`,
  );
});

test('projection refuses subject and grader equality before creating the stage', () => {
  const fx = projectionFixture({ sharedSecret: true });
  let caught: unknown;
  try {
    stage(fx);
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(AttemptProjectionError);
  expect((caught as Error).message).not.toContain(fx.subject);
  expect(existsSync(join(fx.campaignDir, 'attempts', 'a', '.stage'))).toBe(
    false,
  );
});

test('projection refuses an OAuth or unsupported credential before writes', () => {
  const fx = projectionFixture();
  writeFileSync(
    join(fx.corpus, 'credentials.yaml'),
    `${[
      'cred_oauth:',
      '  model: claude-opus-5',
      '  api: anthropic',
      '  auth: oauth',
      '  harnesses: [claude]',
      'cred_sub:',
      '  model: claude-opus-5',
      '  api: anthropic',
      '  auth: subscription',
      '  harnesses: [claude]',
    ].join('\n')}\n`,
  );
  expect(() =>
    prepareAttemptStage({
      campaignDir: fx.campaignDir,
      attemptId: 'oauth',
      agent: 'claude',
      credentialName: 'cred_oauth',
      evalsRoot: fx.corpus,
      bundleDir: fx.bundleDir,
      uid: 1000,
      gid: 1000,
    }),
  ).toThrow(/OAuth home/);
  expect(() =>
    prepareAttemptStage({
      campaignDir: fx.campaignDir,
      attemptId: 'subscription',
      agent: 'claude',
      credentialName: 'cred_sub',
      evalsRoot: fx.corpus,
      bundleDir: fx.bundleDir,
      uid: 1000,
      gid: 1000,
    }),
  ).toThrow(AttemptProjectionError);
});

test('removeAttemptStage removes exactly the stage directory and verifies removal', () => {
  const fx = projectionFixture();
  const prepared = stage(fx);
  writeFileSync(prepared.stdoutLog, 'keep me\n');
  removeAttemptStage(prepared.attemptDir);
  expect(existsSync(prepared.stageDir)).toBe(false);
  expect(existsSync(prepared.stdoutLog)).toBe(true);
  expect(existsSync(join(prepared.attemptDir, 'staging'))).toBe(true);
});

test('projection supports a bedrock bearer subject beside the grader aliases', () => {
  const fx = projectionFixture();
  writeFileSync(
    join(fx.corpus, 'credentials.yaml'),
    `${[
      'cred_bedrock:',
      '  model: anthropic.claude-opus-5',
      '  api: mantle',
      '  auth: bedrock-bearer',
      '  api_key_env: SUBJECT_BEARER',
      '  region: us-east-1',
      '  harnesses: [claude]',
    ].join('\n')}\n`,
  );
  writeFileSync(
    join(fx.bundleDir, 'credentials.env'),
    `SUBJECT_BEARER=${fx.subject}\nQUORUM_GRADER_ANTHROPIC_API_KEY=${fx.grader}\n`,
  );
  const prepared = prepareAttemptStage({
    campaignDir: fx.campaignDir,
    attemptId: 'bedrock',
    agent: 'claude',
    credentialName: 'cred_bedrock',
    evalsRoot: fx.corpus,
    bundleDir: fx.bundleDir,
    uid: 1000,
    gid: 1000,
  });
  expect(readFileSync(prepared.subjectEnvFile, 'utf8')).toBe(
    `SUBJECT_BEARER=${fx.subject}\n`,
  );
});

test('projection emits every Phase 1 grader alias and applicable routing value', () => {
  const fx = projectionFixture();
  writeFileSync(
    join(fx.bundleDir, 'credentials.env'),
    `${[
      `SUBJECT_KEY=${fx.subject}`,
      `QUORUM_GRADER_CLAUDE_CODE_OAUTH_TOKEN=${fx.grader}`,
      'QUORUM_GRADER_ANTHROPIC_AUTH_TOKEN=grader-auth-alias',
      `QUORUM_GRADER_ANTHROPIC_API_KEY=${fx.grader}-api`,
      'QUORUM_GRADER_ANTHROPIC_BASE_URL=https://grader.example/v1',
      'HTTPS_PROXY=https://proxy.example',
      'NODE_EXTRA_CA_CERTS=/etc/certs/ca.pem',
    ].join('\n')}\n`,
  );
  const prepared = stage(fx, 'aliases');
  const grader = readFileSync(prepared.graderEnvFile, 'utf8');
  expect(grader).toContain(
    `QUORUM_GRADER_CLAUDE_CODE_OAUTH_TOKEN=${fx.grader}`,
  );
  expect(grader).toContain(
    'QUORUM_GRADER_ANTHROPIC_AUTH_TOKEN=grader-auth-alias',
  );
  expect(grader).toContain(`QUORUM_GRADER_ANTHROPIC_API_KEY=${fx.grader}-api`);
  expect(grader).toContain(
    'QUORUM_GRADER_ANTHROPIC_BASE_URL=https://grader.example/v1',
  );
  expect(grader).toContain('HTTPS_PROXY=https://proxy.example');
  expect(grader).toContain('NODE_EXTRA_CA_CERTS=/etc/certs/ca.pem');
});

test('projection compares subject material against every alternate grader auth alias', () => {
  const fx = projectionFixture();
  writeFileSync(
    join(fx.bundleDir, 'credentials.env'),
    `SUBJECT_KEY=${fx.subject}\nQUORUM_GRADER_ANTHROPIC_AUTH_TOKEN=${fx.subject}\n`,
  );
  expect(() => stage(fx, 'alternate-equality')).toThrow(AttemptProjectionError);
  expect(
    existsSync(join(fx.campaignDir, 'attempts', 'alternate-equality')),
  ).toBe(false);
});

test('projection refuses missing subject material and unsafe line content before writes', () => {
  const missing = projectionFixture();
  writeFileSync(
    join(missing.bundleDir, 'credentials.env'),
    `QUORUM_GRADER_ANTHROPIC_API_KEY=${missing.grader}\n`,
  );
  expect(() => stage(missing, 'missing')).toThrow(AttemptProjectionError);
  expect(existsSync(join(missing.campaignDir, 'attempts'))).toBe(false);

  const unsafe = projectionFixture();
  writeFileSync(
    join(unsafe.bundleDir, 'credentials.env'),
    `SUBJECT_KEY='unsafe\nline'\nQUORUM_GRADER_ANTHROPIC_API_KEY=${unsafe.grader}\n`,
  );
  expect(() => stage(unsafe, 'unsafe')).toThrow(AttemptProjectionError);
  expect(existsSync(join(unsafe.campaignDir, 'attempts'))).toBe(false);
});

test('projection refuses a staged symlink without touching its target', () => {
  const fx = projectionFixture();
  const attemptDir = join(fx.campaignDir, 'attempts', 'symlink');
  const outside = join(fx.campaignDir, 'outside');
  mkdirSync(outside, { recursive: true });
  mkdirSync(join(fx.campaignDir, 'attempts'), { recursive: true });
  symlinkSync(outside, attemptDir);
  expect(() => stage(fx, 'symlink')).toThrow(AttemptProjectionError);
  expect(existsSync(join(outside, '.stage'))).toBe(false);
});

test('projection cleans a partial stage after an allowlisted special entry blocks a write', () => {
  const fx = projectionFixture();
  const attemptDir = join(fx.campaignDir, 'attempts', 'partial');
  const stageDir = join(attemptDir, '.stage');
  const target = join(fx.campaignDir, 'untouched');
  mkdirSync(stageDir, { recursive: true });
  writeFileSync(target, 'untouched\n');
  symlinkSync(target, join(stageDir, 'grader.env'));
  expect(() => stage(fx, 'partial')).toThrow(AttemptProjectionError);
  expect(existsSync(stageDir)).toBe(false);
  expect(readFileSync(target, 'utf8')).toBe('untouched\n');
});
