import { describe, expect, test } from 'bun:test';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  loadCredentialConfig,
  loadStateConfig,
} from '../src/appliance/config.ts';
import { ApplianceError, toErrorJson } from '../src/appliance/errors.ts';
import { atomicWriteJson } from '../src/appliance/fs.ts';
import {
  CredentialScopeSchema,
  CredentialSelectionSchema,
  type JobContainerEvidence,
  JobRecordSchema,
  LockRecordSchema,
  ProcessGroupIdSchema,
  ProvenanceRecordSchema,
} from '../src/appliance/types.ts';
import {
  type CredentialScope,
  credentialScopeForSelection,
  EMPTY_CREDENTIAL_SCOPE,
  type OAuthProjection,
} from '../src/credentials/scope.ts';
import { repoRoot } from '../src/paths.ts';

function fixture(): { root: string; configPath: string } {
  // Canonical (realpath) fixture root: the appliance boundary validates
  // every absolute path component no-follow, and macOS tmpdir paths
  // traverse the /var symlink.
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'appliance-config-')));
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
    const loaded = loadCredentialConfig(configPath, { ensureState: true });
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
    expect(() => loadCredentialConfig(configPath)).toThrow(/blessed/);
    expect(() => loadStateConfig(configPath)).toThrow(/blessed/);
  });

  test('read-only load does not create or chmod state directories', () => {
    // Canonical (realpath) fixture root: the bundle boundary validates every
    // absolute path component no-follow, and macOS tmpdir paths traverse the
    // /var symlink.
    const root = realpathSync(
      mkdtempSync(join(tmpdir(), 'appliance-config-readonly-')),
    );
    for (const dir of [
      'superpowers-evals',
      'superpowers',
      'gauntlet',
      'credentials/blessed',
    ]) {
      mkdirSync(join(root, dir), { recursive: true });
    }
    writeFileSync(
      join(root, 'credentials/blessed/metadata.json'),
      JSON.stringify({
        bundle_id: 'blessed-readonly',
        rotated_at: '2026-06-18T00:00:00Z',
        providers: [],
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
        gauntlet: {
          path: join(root, 'gauntlet'),
          remote: 'origin',
          ref: 'main',
        },
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

    const loaded = loadCredentialConfig(configPath);

    expect(loaded.paths.jobs).toBe(join(root, 'state/jobs'));
    expect(existsSync(join(root, 'state'))).toBe(false);
  });
});

describe('process group id contract', () => {
  test('accepts only safe integers strictly greater than 1', () => {
    expect(ProcessGroupIdSchema.safeParse(2).success).toBe(true);
    expect(ProcessGroupIdSchema.safeParse(456).success).toBe(true);
    for (const invalid of [
      0,
      1,
      -456,
      456.5,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      2 ** 53,
    ]) {
      expect(ProcessGroupIdSchema.safeParse(invalid).success).toBe(false);
    }
  });

  test('job records reject unsafe host/container process groups', () => {
    const base = {
      host_pid: 123,
      host_pgid: 123,
      container_pid: 456,
      container_pgid: 456,
    };
    const record = (process: unknown): unknown => ({
      schema_version: 1,
      job_id: 'job-1',
      kind: 'run',
      status: 'running',
      created_at: '2026-06-18T00:00:00Z',
      updated_at: '2026-06-18T00:00:00Z',
      started_at: null,
      finished_at: null,
      requester: {
        agent: null,
        thread: null,
        task: null,
        host_user: 'drew',
        remote_identity: 'local:drew',
      },
      command: { argv: ['quorum', 'run'], sanitized: true },
      request: { superpowers_ref: 'main' },
      refs: null,
      credential_bundle: null,
      container: null,
      process,
      artifacts: {
        run_id: null,
        batch_id: null,
        stdout_log: '/tmp/out.log',
        stderr_log: '/tmp/err.log',
        provenance: '/tmp/prov.json',
      },
      progress: null,
      result: { exit_code: null, summary: null },
      error: null,
    });
    expect(JobRecordSchema.safeParse(record(base)).success).toBe(true);
    expect(
      JobRecordSchema.safeParse(record({ ...base, container_pgid: null }))
        .success,
    ).toBe(true);
    expect(
      JobRecordSchema.safeParse(record({ ...base, host_pgid: 1 })).success,
    ).toBe(false);
    expect(
      JobRecordSchema.safeParse(record({ ...base, container_pgid: 0 })).success,
    ).toBe(false);
    expect(
      JobRecordSchema.safeParse(record({ ...base, container_pgid: -456 }))
        .success,
    ).toBe(false);
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

// --- persisted credential request (F13) -------------------------------------
// A job carries exactly one authority for the credential material it may
// receive: the normalized (agent, credential) selection, the scope that
// selection resolved to, and the evals SHA it was resolved against. Records
// written before these fields existed must still read back — as null, never as
// a fabricated scope — while every new writer supplies all three explicitly.
describe('persisted credential request', () => {
  function jobRecordWithoutCredentialFields(
    kind: 'run' | 'run-all' | 'prepare' | 'import',
  ): Record<string, unknown> {
    return {
      schema_version: 1,
      job_id: 'job-legacy',
      kind,
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
        remote_identity: 'local:drew',
      },
      command: { argv: ['quorum', 'run-all'], sanitized: true },
      request: { superpowers_ref: 'main' },
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
      result: { exit_code: null, summary: null },
      error: null,
    };
  }

  test('old job records without the credential triple read back as null', () => {
    for (const kind of ['run', 'run-all', 'prepare', 'import'] as const) {
      const parsed = JobRecordSchema.parse(
        jobRecordWithoutCredentialFields(kind),
      );
      expect(parsed.credential_selection).toBe(null);
      expect(parsed.credential_scope).toBe(null);
      expect(parsed.credential_scope_source_evals_sha).toBe(null);
    }
  });

  test('a live job record round-trips its selection, scope, and source sha', () => {
    const scope = credentialScopeForSelection(repoRoot(), {
      agent: 'codex',
      credential: 'codex_sub',
    });
    const parsed = JobRecordSchema.parse({
      ...jobRecordWithoutCredentialFields('run'),
      credential_selection: { agent: 'codex', credential: null },
      credential_scope: scope,
      credential_scope_source_evals_sha: 'a'.repeat(40),
    });

    expect(parsed.credential_selection).toEqual({
      agent: 'codex',
      credential: null,
    });
    expect(parsed.credential_scope).toEqual(scope);
    expect(parsed.credential_scope_source_evals_sha).toBe('a'.repeat(40));
    // Compile-time: the persisted schema cannot widen past the runtime type
    // the resolver and the container boundary share.
    const persisted: CredentialScope | null = parsed.credential_scope;
    expect(persisted?.kind).toBe('live');
  });

  test('a prepare job record round-trips the asserted empty scope', () => {
    const parsed = JobRecordSchema.parse({
      ...jobRecordWithoutCredentialFields('prepare'),
      credential_selection: null,
      credential_scope: EMPTY_CREDENTIAL_SCOPE,
      credential_scope_source_evals_sha: null,
    });

    expect(parsed.credential_selection).toBe(null);
    expect(parsed.credential_scope).toEqual(EMPTY_CREDENTIAL_SCOPE);
    expect(parsed.credential_scope_source_evals_sha).toBe(null);
  });

  test('the scope schema accepts exactly what the resolver produces', () => {
    // One corpus pair per delivery shape the resolver can emit: env-only,
    // env plus a gemini mode, an OAuth mount, and an OAuth mount carrying a
    // provider. A schema too narrow for any of them would strand that pair.
    for (const [agent, credential] of [
      ['opencode', 'opencode_gpt5'],
      ['gemini', 'gemini_default'],
      ['codex', 'codex_sub'],
      ['pi', 'pi_default'],
    ] as const) {
      const scope = credentialScopeForSelection(repoRoot(), {
        agent,
        credential,
      });
      expect(CredentialScopeSchema.parse(scope)).toEqual(scope);
    }
    expect(CredentialScopeSchema.parse(EMPTY_CREDENTIAL_SCOPE)).toEqual(
      EMPTY_CREDENTIAL_SCOPE,
    );
  });

  test('the scope schema rejects unaudited oauth shapes', () => {
    const live = {
      schemaVersion: 1,
      kind: 'live',
      agent: 'pi',
      runtimeFamily: 'pi',
      credential: 'pi_default',
      agentEnv: [],
      geminiAuthType: null,
    };
    // A kind outside the audited projection table.
    expect(
      CredentialScopeSchema.safeParse({
        ...live,
        oauth: { kind: 'hermes', mountName: 'hermes' },
      }).success,
    ).toBe(false);
    // pi's mount is meaningless without the provider it selects.
    expect(
      CredentialScopeSchema.safeParse({
        ...live,
        oauth: { kind: 'pi', mountName: 'pi' },
      }).success,
    ).toBe(false);
    // An empty scope may not carry material.
    expect(
      CredentialScopeSchema.safeParse({
        ...EMPTY_CREDENTIAL_SCOPE,
        oauth: { kind: 'codex', mountName: 'codex' },
      }).success,
    ).toBe(false);
  });

  test('the selection schema keeps the agent required and the credential nullable', () => {
    expect(
      CredentialSelectionSchema.parse({ agent: 'codex', credential: null }),
    ).toEqual({ agent: 'codex', credential: null });
    expect(
      CredentialSelectionSchema.parse({
        agent: 'codex',
        credential: 'codex_sub',
      }),
    ).toEqual({ agent: 'codex', credential: 'codex_sub' });
    expect(
      CredentialSelectionSchema.safeParse({ credential: 'codex_sub' }).success,
    ).toBe(false);
  });

  test('provenance defaults the credential scope to null and accepts an explicit null', () => {
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
      credential_bundle: { name: 'blessed', bundle_id: 'blessed-2026-06-18-a' },
      container: {
        name: 'quorum-appliance',
        id: 'container-123',
        image_id: 'image-123',
        mount_signature: 'sig-123',
        code_mounts_read_only: false,
      },
      requester: { host_user: 'drew', remote_identity: 'codex-session' },
      command_argv: ['appliance', 'run'],
      tool_versions_path: '/tmp/tool-versions.txt',
      tool_versions_text: null,
    };

    expect(ProvenanceRecordSchema.parse(base).credential_scope).toBe(null);
    expect(
      ProvenanceRecordSchema.parse({ ...base, credential_scope: null })
        .credential_scope,
    ).toBe(null);
  });

  test('durable container evidence keeps its snake-case, old-record-nullable shape', () => {
    const parsed = JobRecordSchema.parse({
      ...jobRecordWithoutCredentialFields('run'),
      container: {
        name: 'quorum-appliance',
        id: null,
        image_id: null,
        mount_signature: 'sig-123',
      },
    });
    // Compile-time: the interface Task 5 converts leases to and from IS the
    // durable job.container shape, not a parallel definition of it.
    const evidence: JobContainerEvidence | null = parsed.container;
    expect(evidence).toEqual({
      name: 'quorum-appliance',
      id: null,
      image_id: null,
      mount_signature: 'sig-123',
    });
    // Evidence never embeds a second scope: the job's top-level
    // credential_scope is the only persisted authority.
    expect(Object.keys(evidence ?? {}).sort()).toEqual([
      'id',
      'image_id',
      'mount_signature',
      'name',
    ]);
  });

  test('every audited oauth projection round-trips through the scope schema', () => {
    // Typed as the union, so a new projection member is a compile error here
    // until the persisted schema learns it too.
    const projections: OAuthProjection[] = [
      { kind: 'codex', mountName: 'codex' },
      { kind: 'gemini', mountName: 'gemini' },
      { kind: 'antigravity', mountName: 'gemini' },
      { kind: 'kimi', mountName: 'kimi' },
      { kind: 'pi', mountName: 'pi', provider: 'openai-codex' },
    ];
    for (const oauth of projections) {
      const scope: CredentialScope = {
        schemaVersion: 1,
        kind: 'live',
        agent: 'fixture-agent',
        runtimeFamily: 'fixture-family',
        credential: 'fixture-credential',
        agentEnv: [],
        geminiAuthType: null,
        oauth,
      };
      expect(CredentialScopeSchema.parse(scope)).toEqual(scope);
    }
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
