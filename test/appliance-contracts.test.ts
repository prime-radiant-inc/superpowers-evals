import { describe, expect, test } from 'bun:test';
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/appliance/config.ts';
import { ApplianceError, toErrorJson } from '../src/appliance/errors.ts';
import { atomicWriteJson } from '../src/appliance/fs.ts';
import {
  JobRecordSchema,
  LockRecordSchema,
  ProvenanceRecordSchema,
} from '../src/appliance/types.ts';

function fixture(): { root: string; configPath: string } {
  const root = mkdtempSync(join(tmpdir(), 'appliance-config-'));
  for (const dir of [
    'superpowers-evals',
    'superpowers',
    'gauntlet',
    'state',
    'credentials/blessed',
  ]) {
    mkdirSync(join(root, dir), {
      recursive: true,
      mode: dir === 'state' ? 0o755 : 0o700,
    });
  }
  writeFileSync(
    join(root, 'credentials/blessed/metadata.json'),
    JSON.stringify({
      bundle_id: 'blessed-2026-06-18-a',
      rotated_at: '2026-06-18T00:00:00Z',
      providers: ['anthropic', 'openai'],
      note: 'test bundle',
    }),
  );
  const configPath = join(root, 'appliance.json');
  writeFileSync(
    configPath,
    JSON.stringify({
      root,
      evals: {
        path: join(root, 'superpowers-evals'),
        remote: 'origin',
        ref: 'main',
      },
      superpowers: { path: join(root, 'superpowers'), remote: 'origin' },
      gauntlet: { path: join(root, 'gauntlet'), remote: 'origin', ref: 'main' },
      credential_bundle: {
        name: 'blessed',
        path: join(root, 'credentials/blessed'),
      },
      container: {
        name: 'quorum-appliance',
        results_root: join(root, 'superpowers-evals/results'),
      },
    }),
  );
  return { root, configPath };
}

describe('appliance config', () => {
  test('loads host config and bundle metadata', () => {
    const { root, configPath } = fixture();
    const loaded = loadConfig(configPath);
    expect(loaded.config.root).toBe(root);
    expect(loaded.bundle.bundle_id).toBe('blessed-2026-06-18-a');
    expect(statSync(join(root, 'state')).mode & 0o777).toBe(0o700);
    expect(loaded.paths.jobs).toBe(join(root, 'state/jobs'));
    expect(loaded.paths.locks).toBe(join(root, 'state/locks'));
    expect(loaded.paths.provenance).toBe(join(root, 'state/provenance'));
    expect(statSync(loaded.paths.jobs).mode & 0o777).toBe(0o700);
    expect(statSync(loaded.paths.locks).mode & 0o777).toBe(0o700);
    expect(statSync(loaded.paths.provenance).mode & 0o777).toBe(0o700);
  });

  test('rejects a credential bundle name other than blessed', () => {
    const { configPath } = fixture();
    const raw = JSON.parse(readFileSync(configPath, 'utf8'));
    raw.credential_bundle.name = 'personal';
    writeFileSync(configPath, JSON.stringify(raw));
    expect(() => loadConfig(configPath)).toThrow(/blessed/);
  });
});

describe('appliance error json', () => {
  test('serializes stable machine-readable failures', () => {
    const err = new ApplianceError(
      'lock_busy',
      'preflight',
      'run.lock is held',
    );
    expect(toErrorJson(err)).toEqual({
      ok: false,
      error: {
        code: 'lock_busy',
        step: 'preflight',
        message: 'run.lock is held',
      },
    });
  });
});

describe('appliance contracts', () => {
  test('accepts the planned initial job record shape with null lifecycle fields', () => {
    const parsed = JobRecordSchema.parse({
      schema_version: 1,
      job_id: 'job-123',
      kind: 'run',
      status: 'queued',
      created_at: '2026-06-18T00:00:00Z',
      updated_at: '2026-06-18T00:00:00Z',
      started_at: null,
      finished_at: null,
      requester: {
        agent: 'codex',
        thread: null,
        task: null,
        host_user: 'drew',
        remote_identity: 'codex-session',
      },
      command: {
        argv: ['appliance', 'run'],
        sanitized: true,
      },
      request: {
        superpowers_ref: 'feature/ref',
      },
      refs: null,
      credential_bundle: null,
      container: null,
      process: null,
      artifacts: {
        run_id: null,
        batch_id: null,
        stdout_log: '/tmp/stdout.log',
        stderr_log: '/tmp/stderr.log',
        provenance: '/tmp/provenance.json',
      },
      progress: null,
      result: {
        exit_code: null,
        summary: null,
      },
      error: null,
    });

    expect(parsed.request.superpowers_ref).toBe('feature/ref');
  });

  test('accepts helper-created job records with no coding-agent identity', () => {
    const result = JobRecordSchema.safeParse({
      schema_version: 1,
      job_id: 'job-prepare',
      kind: 'prepare',
      status: 'preflighting',
      created_at: '2026-06-18T00:00:00Z',
      updated_at: '2026-06-18T00:00:00Z',
      started_at: null,
      finished_at: null,
      requester: {
        agent: null,
        thread: null,
        task: null,
        host_user: 'drew',
        remote_identity: 'ssh:drew',
      },
      command: {
        argv: ['evals-appliance', 'prepare', '--ref', 'main'],
        sanitized: true,
      },
      request: {
        superpowers_ref: 'main',
      },
      refs: null,
      credential_bundle: null,
      container: null,
      process: null,
      artifacts: {
        run_id: null,
        batch_id: null,
        stdout_log: '/tmp/stdout.log',
        stderr_log: '/tmp/stderr.log',
        provenance: '/tmp/provenance.json',
      },
      progress: null,
      result: {
        exit_code: null,
        summary: null,
      },
      error: null,
    });

    expect(result.success).toBe(true);
  });

  test('accepts the planned lock record file shape', () => {
    const result = LockRecordSchema.safeParse({
      job_id: 'job-123',
      name: 'run.lock',
      host: 'appliance-host',
      pid: 12345,
      pgid: 12345,
      started_at: '2026-06-18T00:00:00Z',
      command: 'run-all',
      refs: null,
    });

    expect(result.success).toBe(true);
  });

  test('rejects job records with non-stable error codes', () => {
    const result = JobRecordSchema.safeParse({
      schema_version: 1,
      job_id: 'job-123',
      kind: 'run',
      status: 'failed',
      created_at: '2026-06-18T00:00:00Z',
      updated_at: '2026-06-18T00:00:00Z',
      started_at: null,
      finished_at: null,
      requester: {
        agent: 'codex',
        thread: null,
        task: null,
        host_user: 'drew',
        remote_identity: 'codex-session',
      },
      command: {
        argv: ['appliance', 'run'],
        sanitized: true,
      },
      request: {
        superpowers_ref: 'main',
      },
      refs: {
        superpowers_requested_ref: 'main',
        superpowers_resolved_sha: 'a'.repeat(40),
        evals_ref: 'main',
        evals_resolved_sha: 'b'.repeat(40),
        gauntlet_ref: 'main',
        gauntlet_built_sha: 'c'.repeat(40),
      },
      credential_bundle: {
        name: 'blessed',
        bundle_id: 'blessed-2026-06-18-a',
      },
      container: {
        name: 'quorum-appliance',
        id: 'container-123',
        image_id: 'image-123',
        mount_signature: 'sig-123',
      },
      process: {
        host_pid: 123,
        host_pgid: 123,
        container_pid: 456,
        container_pgid: 456,
      },
      artifacts: {
        run_id: null,
        batch_id: null,
        stdout_log: '/tmp/stdout.log',
        stderr_log: '/tmp/stderr.log',
        provenance: '/tmp/provenance.json',
      },
      progress: {
        last_heartbeat_at: null,
        running: 0,
        done: 0,
        queued: 1,
      },
      result: {
        exit_code: 1,
        summary: 'failed',
      },
      error: {
        code: 'totally_new_error',
        step: 'run',
        message: 'bad things happened',
      },
    });

    expect(result.success).toBe(false);
    expect(result.error?.issues.map((issue) => issue.path.join('.'))).toContain(
      'error.code',
    );
  });

  test('requires read-only mount evidence and a tool versions artifact', () => {
    const base = {
      schema_version: 1,
      job_id: 'job-123',
      created_at: '2026-06-18T00:00:00Z',
      refs: {
        superpowers_requested_ref: 'main',
        superpowers_resolved_sha: 'a'.repeat(40),
        evals_ref: 'main',
        evals_resolved_sha: 'b'.repeat(40),
        gauntlet_ref: 'main',
        gauntlet_built_sha: 'c'.repeat(40),
      },
      credential_bundle: {
        name: 'blessed',
        bundle_id: 'blessed-2026-06-18-a',
      },
      container: {
        name: 'quorum-appliance',
        id: 'container-123',
        image_id: 'image-123',
        mount_signature: 'sig-123',
      },
      requester: {
        host_user: 'drew',
        remote_identity: 'codex-session',
      },
      command_argv: ['appliance', 'run'],
    };

    expect(
      ProvenanceRecordSchema.safeParse({
        ...base,
        tool_versions_path: null,
        tool_versions_text: null,
      }).success,
    ).toBe(false);

    expect(
      ProvenanceRecordSchema.safeParse({
        ...base,
        container: {
          ...base.container,
          code_mounts_read_only: true,
        },
        tool_versions_path: '/tmp/tool-versions.txt',
        tool_versions_text: null,
      }).success,
    ).toBe(true);

    expect(
      ProvenanceRecordSchema.safeParse({
        ...base,
        container: {
          ...base.container,
          code_mounts_read_only: false,
        },
        tool_versions_path: null,
        tool_versions_text: 'evals-tool-versions: available',
      }).success,
    ).toBe(true);
  });
});

describe('atomicWriteJson', () => {
  test('writes private parseable json without leaving temp files', () => {
    const dir = mkdtempSync(join(tmpdir(), 'appliance-json-'));
    const path = join(dir, 'record.json');
    atomicWriteJson(path, { a: 1 });

    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({ a: 1 });
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(readdirSync(dir)).toEqual(['record.json']);
  });
});
