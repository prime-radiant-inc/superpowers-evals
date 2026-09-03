# Campaign Appliance V2 Child 1 — Attempt Worker Skeleton Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move the campaign controller onto the appliance host and run every attempt in one fresh Docker container (`docker create` → `docker start`, attempt lifetime = container lifetime), reached through one new helper verb `evals-appliance campaign run <campaign-id>`, completing when one real attempt runs on the appliance through the helper and its manifest-published verdict is journaled.

**Architecture:** The existing D3 engine (dispatcher, journal, locks, sensors, classifier, recovery) is unchanged except that a spawned child may be a container. A detached appliance worker acquires `run.lock`, runs the controller in-process on the host, and injects a `ContainerAttemptSpawner` through the dispatcher's existing `spawner` parameter. Per attempt the controller stages exact subject/grader credential files, `docker create`s a container with a fixed mount list, follows durable per-attempt log files for the `run_allocated` protocol line, and after exit publishes the run through a verified manifest into `results/` before journaling the terminal event. Cancellation and verified death operate on the exact container ID (`docker stop` → `docker kill` → inspect); the container is the process namespace, so no tmux probe is needed on the container path.

**Tech Stack:** TypeScript on Bun (≥1.3), zod contracts, commander CLI, `bun:test`, Docker CLI via the existing `CommandRunner` seam (plus one injected async `docker wait` seam), bash entrypoint shipped in the frozen evals snapshot.

**Spec:** `docs/superpowers/specs/2026-09-02-campaign-appliance-v2-attempt-worker-skeleton-design.md` (child 1). Parent: `docs/superpowers/specs/2026-09-02-campaign-appliance-v2-design.md`.

## Global Constraints

- Every commit leaves the tree green: `bun run check` (biome + tsc + bun test), `bun run quorum check`, and `git diff --check` all pass.
- V1 contracts are untouched except ONE additive change: the journal's `run_allocated` event gains a strict container-identity payload arm alongside the two existing payloads. Child 3 deletes both with the rest of V1.
- No new `quorum` CLI flag. No `docker exec` anywhere on the campaign path. No new dependencies.
- No credential value may appear in argv, Docker configuration (`--env`, labels), job records, journal events, or log paths. Journal key-grant records carry names only, as today.
- No change to ordinary `quorum run`, `run-all`, or the Phase 1 appliance job path (acceptance criterion 12).
- OAuth directory projections are out of scope: a campaign cell whose credential needs an OAuth home refuses at admission with a typed error (V2 accepts only `api-key` and `bedrock-bearer`).
- Portable tests run under `bun test` on any host with a fake `CommandRunner` and no Docker. The Linux Docker integration suite is skipped unless `QUORUM_DOCKER_INTEGRATION=1`.
- Child 1's cancel works only through the live controller. Crash-cut verification, created-but-unbound reconciliation, marker-first cancellation, and controller-death fencing are child 2; do not build them here.
- The final live proof spends real money (one attempt) and requires Drew's explicit go-ahead before execution. Do not run Task 17's live steps without it.
- Style: match existing code — explicit `.ts` import extensions, `import type`, named error classes, comments only where the why is non-obvious.

## File Structure

### New files

| File | Responsibility |
|---|---|
| `src/campaign/container-spawner.ts` | `ContainerAttemptSpawner` (implements `ChildSpawner`, `kind: 'container'`), the `AttemptDocker` seam, exact `docker create` argv, mount verification, durable-log line following, `docker wait` + exit inspection, `exit.json`, and the container stop routine. |
| `src/campaign/attempt-projection.ts` | Per-attempt stage directory, subject/grader env files over the existing credential-scope projection code, all-pairs equality refusal, OAuth-cell refusal, stage removal. |
| `src/campaign/attempt-publish.ts` | Host-side publication: manifest re-parse, digest/size/path verification, exactly one atomic rename into the results root. |
| `src/runner/manifest.ts` | Worker-side manifest writer (invoked from the runner's terminal path when a campaign identity is present). |
| `src/appliance/campaign-run.ts` | The `campaign-run` worker body: image digest re-check, `run.lock`, live-spend lock env, in-process controller with the injected container spawner, job terminal state. |
| `container/attempt-entrypoint.sh` | Shipped in every frozen snapshot: redirects stdio to the durable logs, sources the two credential files, `exec bun "$@"`. |
| `test/campaign-container-spawner.test.ts` | Portable fake-docker tests for argv, mount verification, follow/settle, and stop. |
| `test/campaign-attempt-projection.test.ts` | Portable projection tests (contents, modes, refusals). |
| `test/campaign-attempt-publish.test.ts` | Portable publication tests (digests, path traversal, symlink, single rename). |
| `test/runner-manifest.test.ts` | Portable manifest writer tests. |
| `test/appliance-campaign-run.test.ts` | Portable verb + worker tests (refusals, job record, detached dispatch, cancel branch). |
| `test/linux/campaign-attempt-docker.test.ts` | Linux-only Docker integration suite, gated on `QUORUM_DOCKER_INTEGRATION=1`. |

### Modified files

| File | Change |
|---|---|
| `src/campaign/spawn.ts` | `CampaignChildHandle` union, `SpawnedCampaignChild.handle`, `ChildSpawner.kind`, `AttemptMount`/`AttemptSpawnContext` types, `attempt?:` field on `CampaignChildSpec`. |
| `src/contracts/campaign/journal-events.ts` | Additive strict `run_allocated` container payload arm. |
| `src/campaign/dispatcher.ts` | Route by handle kind: staging `--out-root`, container payload journaling, publish-then-terminal on exit, verified death by kind, stage removal. |
| `src/campaign/recovery.ts` | `killJournaledPgids` dispatches the container payload arm through an injected `ContainerStopper`. |
| `src/cli/campaign.ts` | `campaignRun` accepts an injected spawner; no new flag. |
| `src/cli/run-command.ts` | SIGTERM joins SIGINT in the one idempotent stop path. |
| `src/appliance/types.ts` | `campaign-run` job kind, campaign job block, optional `live_spend_lock` config field. |
| `src/appliance/jobs.ts` | `campaign-run` `CreateJobRequest` variant + persistence. |
| `src/appliance/cli.ts` | `campaign` group, `run` verb, `campaignRun` action. |
| `src/appliance/process.ts` | Detached worker dispatch by kind; `cancel` branch for `campaign-run`. |
| `src/appliance/credential-scope.ts` | Export the projection internals attempt-projection reuses (no behavior change). |
| `src/runner/index.ts` | Invoke the manifest writer after `verdict.json` when a campaign identity is present. |
| `docs/appliance-runbook.md` | `campaign run` section. |

---

### Task 1: Handle union and the additive `run_allocated` container payload

**Files:**
- Modify: `src/campaign/spawn.ts`
- Modify: `src/contracts/campaign/journal-events.ts`
- Modify: `src/campaign/dispatcher.ts` (compile-time routing only; behavior-preserving)
- Modify: `src/campaign/recovery.ts` (compile-time routing only)
- Modify: `test/campaign-spawn.test.ts`, `test/campaign-dispatcher.test.ts` (fake children)
- Test: `test/campaign-spawn.test.ts` (new cases), `test/campaign-contracts-digest.test.ts` stays untouched

**Interfaces:**
- Produces: `CampaignChildHandle`, `SpawnedCampaignChild.handle`, `ChildSpawner.kind`, `RunAllocatedContainerPayload` (zod), `readRunAllocatedGrants` unchanged. Every later task consumes these.

- [ ] **Step 1: Write the failing tests for the handle union and container payload**

Append to `test/campaign-spawn.test.ts`:

```typescript
test('detached spawner kind is process and the handle carries the pgid', async () => {
  const spawner = new DetachedChildSpawner();
  expect(spawner.kind).toBe('process');
  const dir = mkdtempSync(join(tmpdir(), 'spawn-kind-'));
  const script = join(dir, 'child.ts');
  writeFileSync(script, "console.log('run_allocated: run-k1');\n");
  const child = spawner.spawn({
    command: 'bun',
    args: [script],
    cwd: dir,
    env: { PATH: getEnv('PATH') ?? '' },
  });
  expect(child.handle.kind).toBe('process');
  if (child.handle.kind === 'process') {
    expect(child.handle.pgid).toBeGreaterThan(1);
  }
  await new Promise<void>((resolve) => child.onExit(() => resolve()));
});
```

Create `test/campaign-journal-run-allocated-container.test.ts`:

```typescript
import { expect, test } from 'bun:test';
import { RunAllocatedEvent, readRunAllocatedGrants } from '../src/contracts/campaign/journal-events.ts';

const containerId = 'a'.repeat(64);
const imageDigest = `sha256:${'b'.repeat(64)}`;

test('run_allocated container arm round-trips with container identity and grants', () => {
  const parsed = RunAllocatedEvent.parse({
    seq: 1,
    ts_ms: 5,
    type: 'run_allocated',
    payload: {
      attempt_id: 'c1:s:arm_a:r1:a1',
      run_id: 'run-1',
      container_id: containerId,
      image_digest: imageDigest,
      key_grants: [
        { role: 'subject', env: 'SUBJECT_KEY' },
        { role: 'grader', env: 'QUORUM_GRADER_API_KEY' },
      ],
    },
  });
  expect('pgid' in parsed.payload).toBe(false);
  expect(readRunAllocatedGrants(parsed.payload)).toEqual([
    { role: 'subject', env: 'SUBJECT_KEY' },
    { role: 'grader', env: 'QUORUM_GRADER_API_KEY' },
  ]);
});

test('run_allocated container arm rejects malformed identity in every field', () => {
  const base = {
    seq: 1,
    ts_ms: 5,
    type: 'run_allocated' as const,
  };
  // container_id must be a 64-hex docker id
  expect(() =>
    RunAllocatedEvent.parse({
      ...base,
      payload: { attempt_id: 'a', run_id: 'r', container_id: 'XYZ', image_digest: imageDigest, key_grants: [] },
    }),
  ).toThrow();
  // image_digest must be sha256-prefixed
  expect(() =>
    RunAllocatedEvent.parse({
      ...base,
      payload: { attempt_id: 'a', run_id: 'r', container_id: containerId, image_digest: 'latest', key_grants: [] },
    }),
  ).toThrow();
  // the container arm never carries pgid (strict objects discriminate the union)
  expect(() =>
    RunAllocatedEvent.parse({
      ...base,
      payload: { attempt_id: 'a', run_id: 'r', pgid: 42, container_id: containerId, image_digest: imageDigest, key_grants: [] },
    }),
  ).toThrow();
  // at most one grant per role
  expect(() =>
    RunAllocatedEvent.parse({
      ...base,
      payload: {
        attempt_id: 'a',
        run_id: 'r',
        container_id: containerId,
        image_digest: imageDigest,
        key_grants: [
          { role: 'subject', env: 'A' },
          { role: 'subject', env: 'B' },
        ],
      },
    }),
  ).toThrow();
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test test/campaign-spawn.test.ts test/campaign-journal-run-allocated-container.test.ts`
Expected: FAIL — `kind` missing on `DetachedChildSpawner`, `handle` missing on the child, container arm not parseable.

- [ ] **Step 3: Implement the handle union in spawn.ts**

In `src/campaign/spawn.ts`, replace the `SpawnedCampaignChild` interface and add the union plus attempt types (keep everything else):

```typescript
export type CampaignChildHandle =
  | { readonly kind: 'process'; readonly pgid: number }
  | {
      readonly kind: 'container';
      readonly containerId: string;
      readonly imageDigest: string;
    };

/** One bind mount the attempt container receives. The complete ordered list
 *  is verified against `docker inspect` before `docker start` — any extra
 *  or missing mount removes the exact container and fails the attempt. */
export interface AttemptMount {
  readonly source: string;
  readonly target: string;
  readonly mode: 'ro' | 'rw';
}

/** Container-path spawn context carried on the spec. DetachedChildSpawner
 *  ignores it; ContainerAttemptSpawner requires it. */
export interface AttemptSpawnContext {
  readonly attemptId: string;
  readonly attemptDir: string;
  readonly stdoutLog: string;
  readonly stderrLog: string;
  readonly homeDir: string;
  readonly entrypoint: string;
  readonly mounts: readonly AttemptMount[];
}

export interface CampaignChildSpec {
  readonly command: string;
  readonly args: readonly string[];
  /** Inside the snapshot (R-SPN-8). */
  readonly cwd: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  /** Present exactly on the container path. */
  readonly attempt?: AttemptSpawnContext;
}

export interface SpawnedCampaignChild {
  /** Process-or-container discriminated handle: process-group kills and
   *  identity probes apply to 'process' only; container death is verified
   *  by inspecting the exact container ID. */
  readonly handle: CampaignChildHandle;
  /** Buffered protocol surface: everything observed so far. */
  readonly stdoutLines: readonly string[];
  readonly stderrLines: readonly string[];
  onStdoutLine(cb: (line: string) => void): void;
  onStderrLine(cb: (line: string) => void): void;
  onExit(cb: (info: ChildExitInfo) => void): void;
}

export interface ChildSpawner {
  readonly kind: 'process' | 'container';
  spawn(spec: CampaignChildSpec): SpawnedCampaignChild;
}
```

In `DetachedChildSpawner` add `readonly kind = 'process' as const;` and change the returned object's `pid: child.pid` to `handle: { kind: 'process' as const, pgid: child.pid }`.

- [ ] **Step 4: Implement the container payload arm in journal-events.ts**

In `src/contracts/campaign/journal-events.ts`, after `RunAllocatedGrantPayload`, add:

```typescript
export const ContainerIdSchema = z.string().regex(/^[0-9a-f]{64}$/);
export const ImageDigestSchema = z.string().regex(/^sha256:[0-9a-f]{64}$/);

const RunAllocatedContainerPayload = z
  .object({
    attempt_id: z.string().min(1),
    run_id: z.string().min(1),
    container_id: ContainerIdSchema,
    image_digest: ImageDigestSchema,
    key_grants: z.array(KeyGrantEntrySchema).max(2),
  })
  .strict()
  .superRefine((payload, ctx) => {
    const roles = payload.key_grants.map((g) => g.role);
    if (new Set(roles).size !== roles.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['key_grants'],
        message: 'at most one grant entry per role',
      });
    }
  });
```

Update the union and its comment:

```typescript
export type RunAllocatedPayload =
  | z.infer<typeof RunAllocatedLegacyPayload>
  | z.infer<typeof RunAllocatedGrantPayload>
  | z.infer<typeof RunAllocatedContainerPayload>;
export const RunAllocatedEvent = envelope(
  'run_allocated',
  // Child-1 third arm: the container path journals container identity in
  // place of pgid. Strict objects keep the union key-discriminable.
  z.union([
    RunAllocatedGrantPayload,
    RunAllocatedContainerPayload,
    RunAllocatedLegacyPayload,
  ]),
);
```

`readRunAllocatedGrants` needs no change (the container arm carries `key_grants`).

- [ ] **Step 5: Route the dispatcher by handle kind (compile-time, behavior-preserving)**

In `src/campaign/dispatcher.ts`:

1. Add a helper next to the spawner setup:

```typescript
    const pgidOf = (child: SpawnedCampaignChild): number => {
      if (child.handle.kind !== 'process') {
        throw new DispatcherError(
          'process-group operation on a container child — the container path routes through docker stop (child 1 routing)',
        );
      }
      return child.handle.pgid;
    };
```

2. Replace every `child.pid` occurrence with `pgidOf(child)` (sites: `recordAllocation`'s `signalGroup(child.pid, 0)` check and `pgid: child.pid` payload, the allocation-wait timeout kill, `superviseSample`'s `identity.startTimeMs(child.pid)`, and any verified-death/teardown sites that read a live child's group).

3. In `recordAllocation`, journal the arm matching the handle:

```typescript
      await appendCritical([
        {
          type: 'run_allocated',
          payload:
            child.handle.kind === 'container'
              ? {
                  attempt_id: sample.attemptId,
                  run_id: runId,
                  container_id: child.handle.containerId,
                  image_digest: child.handle.imageDigest,
                  ...keyGrantsPayload(sample.grants),
                }
              : {
                  attempt_id: sample.attemptId,
                  run_id: runId,
                  pgid: child.handle.pgid,
                  ...keyGrantsPayload(sample.grants),
                },
        },
      ]);
```

Keep the `signalGroup(child.pid, 0) === 'esrch'` pre-journal liveness check on the process arm only; on the container arm the container was verified at create/start (Task 2), so no pre-journal probe runs.

4. In `superviseSample`, set the birth stamp only on the process path: `sample.childBirthTsMs = child.handle.kind === 'process' ? identity.startTimeMs(child.handle.pgid) : null;` and widen `childBirthTsMs` to `number | null` on `LiveSampleState` (grep the declaration and every reader; `killGroupVerified` receives `birthTsMs: null` only from process handles, which never happens — container handles never reach `killGroupVerified` in this task).

5. Where the dispatcher's journal fold reads `run_allocated` payloads (the `case 'run_allocated':` site), branch: `const pgid = 'pgid' in event.payload ? event.payload.pgid : null;` and keep every existing behavior for the process arm; the container arm carries no group to track.

- [ ] **Step 6: Route recovery by payload arm (compile-time, loud skip)**

In `src/campaign/recovery.ts` `killJournaledPgids`, in the `for (const event of args.events)` loop, before `disposeGroup`:

```typescript
    if ('container_id' in event.payload) {
      // Child 1 container arm: verified death is a container stop against the
      // exact container ID. The stop seam lands with the container spawner
      // (Task 11); until then a journaled container handle here is LOUD.
      stream.write(
        `run_allocated ${event.payload.attempt_id} journaled a container handle (${event.payload.container_id}) — container stop seam not injected; recorded, not verified\n`,
      );
      continue;
    }
```

- [ ] **Step 7: Update the test fakes**

In `test/campaign-dispatcher.test.ts`, `FakeChild` (line ~262): replace the `readonly pid: number` field and its constructor assignment with:

```typescript
  readonly handle: { readonly kind: 'process'; readonly pgid: number };
```

and in the constructor: `this.handle = { kind: 'process', pgid };`. Add `readonly kind = 'process' as const;` to `FakeSpawner`. Fix every `child.pid` / `fake.pid` reference in the test file to `child.handle.pgid` (guard with `kind === 'process'` where the type requires it). Do the same for any other test fake implementing `ChildSpawner` or `SpawnedCampaignChild` (search: `rg -n "pid:|implements ChildSpawner" test/`).

- [ ] **Step 8: Run the full gate**

Run: `bun run check && bun run quorum check && git diff --check`
Expected: PASS — the portable suite is green with identical process-path behavior.

- [ ] **Step 9: Commit**

```bash
git add src/campaign/spawn.ts src/contracts/campaign/journal-events.ts src/campaign/dispatcher.ts src/campaign/recovery.ts test/campaign-spawn.test.ts test/campaign-journal-run-allocated-container.test.ts test/campaign-dispatcher.test.ts
git commit -m "feat(campaign): add the container child handle and run_allocated arm"
```

---

### Task 2: ContainerAttemptSpawner — exact create argv and mount verification

**Files:**
- Create: `src/campaign/container-spawner.ts`
- Test: `test/campaign-container-spawner.test.ts`

**Interfaces:**
- Consumes: `CampaignChildSpec`, `AttemptSpawnContext`, `AttemptMount`, `SpawnError` (from `src/campaign/spawn.ts`), `CommandRunner` (from `src/agents/command-runner.ts`).
- Produces: `AttemptDocker`, `realAttemptDocker`, `ContainerAttemptSpawner` (partial: create/verify only; follow/wait lands in Task 3, stop in Task 4), `buildAttemptMounts`, `AttemptContainerError`.

- [ ] **Step 1: Write the failing tests**

Create `test/campaign-container-spawner.test.ts`:

```typescript
import { expect, test } from 'bun:test';
import type { CommandResult, CommandRunner } from '../src/agents/command-runner.ts';
import { FakeClock } from '../src/scheduler/clock.ts';
import type { CampaignChildSpec } from '../src/campaign/spawn.ts';
import {
  buildAttemptMounts,
  ContainerAttemptSpawner,
} from '../src/campaign/container-spawner.ts';

class FakeDocker implements CommandRunner {
  readonly calls: { command: string; args: readonly string[] }[] = [];
  results: ((args: readonly string[]) => CommandResult)[] = [];

  run(command: string, args: readonly string[], _options?: unknown): CommandResult {
    this.calls.push({ command, args });
    const next = this.results.shift();
    if (next === undefined) return { status: 0, stdout: '', stderr: '' };
    return next(args);
  }
}

const attemptCtx = (over: Partial<NonNullable<CampaignChildSpec['attempt']>> = {}) => ({
  attemptId: 'c1:s:arm_a:r1:a1',
  attemptDir: '/camp/attempts/a1',
  stdoutLog: '/camp/attempts/a1/stdout.log',
  stderrLog: '/camp/attempts/a1/stderr.log',
  homeDir: '/camp/attempts/a1/home',
  entrypoint: '/camp/evals/container/attempt-entrypoint.sh',
  mounts: buildAttemptMounts({
    evalsRoot: '/camp/evals',
    gauntletRoot: '/camp/gauntlet',
    binRoot: '/camp/bin',
    superpowersTree: '/camp/superpowers-abc',
    attemptDir: '/camp/attempts/a1',
    subjectEnvFile: '/camp/attempts/a1/.stage/subject.env',
    graderEnvFile: '/camp/attempts/a1/.stage/grader.env',
    passwdFile: '/camp/attempts/a1/.stage/passwd',
    groupFile: '/camp/attempts/a1/.stage/group',
  }),
  ...over,
});

const spec = (over: Partial<CampaignChildSpec> = {}): CampaignChildSpec => ({
  command: 'bun',
  args: ['/camp/evals/src/cli/index.ts', 'run', 'scenarios/s'],
  cwd: '/camp/evals',
  env: {},
  attempt: attemptCtx(),
  ...over,
});

const makeSpawner = (runner: FakeDocker) =>
  new ContainerAttemptSpawner({
    runner,
    clock: new FakeClock(),
    stream: { write: () => {} },
    campaignId: 'c'.repeat(64),
    campaignDir: '/camp',
    imageRef: 'superpowers-evals:local',
    imageDigest: `sha256:${'b'.repeat(64)}`,
    evalsSha: 'd'.repeat(40),
    bundleDir: '/bundle',
    uid: 1000,
    gid: 1000,
    dockerWait: async () => 0,
  });

test('docker create argv: init, name, labels, user, workdir, env allowlist, tmpfs, mounts, command', () => {
  const runner = new FakeDocker();
  const spawner = makeSpawner(runner);
  spawner.spawn(spec());
  const create = runner.calls[0]!;
  expect(create.command).toBe('docker');
  expect(create.args[0]).toBe('create');
  const args = [...create.args];
  expect(args).toContain('--init');
  expect(args[args.indexOf('--name') + 1]).toBe(
    `quorum-attempt-${'c'.repeat(64)}-c1:s:arm_a:r1:a1`,
  );
  expect(args.filter((a) => a === '--label')).toHaveLength(3);
  expect(args).toContain(`quorum.campaign_id=${'c'.repeat(64)}`);
  expect(args).toContain('quorum.attempt_id=c1:s:arm_a:r1:a1');
  expect(args).toContain(`quorum.evals_sha=${'d'.repeat(40)}`);
  expect(args[args.indexOf('--user') + 1]).toBe('1000:1000');
  expect(args[args.indexOf('--workdir') + 1]).toBe('/camp/evals');
  // env allowlist: HOME, TMPDIR, TMUX_TMPDIR, XDG_*, covered marker, attempt dir — no secrets
  expect(args).toContain('HOME=/camp/attempts/a1/home');
  expect(args).toContain('TMPDIR=/run/quorum/attempt');
  expect(args).toContain('TMUX_TMPDIR=/run/quorum/attempt');
  expect(args).toContain('QUORUM_ATTEMPT_DIR=/camp/attempts/a1');
  expect(args).toContain('QUORUM_COVERED_BY_LIVE_SPEND_LOCK=1');
  expect(args.filter((a) => a === '--tmpfs')).toHaveLength(2);
  expect(args).toContain('/run/quorum/attempt:rw,noexec,nosuid,size=2147483648');
  // the image, then the entrypoint, then the dispatcher argv (minus the leading 'bun')
  expect(args[args.length - 5]).toBe('superpowers-evals:local');
  expect(args[args.length - 4]).toBe('/camp/evals/container/attempt-entrypoint.sh');
  expect(args[args.length - 3]).toBe('/camp/evals/src/cli/index.ts');
  expect(args[args.length - 2]).toBe('run');
  expect(args[args.length - 1]).toBe('scenarios/s');
  // no credential value may appear in any arg
  for (const arg of args) expect(arg).not.toMatch(/sk-ant|KEY=/);
});

test('mount verification rejects an extra mount and removes the exact container', () => {
  const runner = new FakeDocker();
  const id = 'f'.repeat(64);
  runner.results.push(() => ({ status: 0, stdout: `${id}\n`, stderr: '' })); // create
  const expected = attemptCtx().mounts;
  const extra = [
    ...expected.map((m) => ({
      Type: 'bind',
      Source: m.source,
      Target: m.target,
      ReadOnly: m.mode === 'ro',
    })),
    { Type: 'bind', Source: '/etc/shadow', Target: '/leak', ReadOnly: false },
  ];
  runner.results.push(() => ({
    status: 0,
    stdout: JSON.stringify([{ HostConfig: { Mounts: extra } }]),
    stderr: '',
  })); // inspect
  runner.results.push(() => ({ status: 0, stdout: '', stderr: '' })); // rm
  const spawner = makeSpawner(runner);
  expect(() => spawner.spawn(spec())).toThrow(/mount/);
  const last = runner.calls.at(-1)!;
  expect(last.args).toEqual(['rm', id]);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test test/campaign-container-spawner.test.ts`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement container-spawner.ts (create + verify)**

Create `src/campaign/container-spawner.ts`:

```typescript
import { openSync, closeSync, writeFileSync } from 'node:fs';
import type { CommandResult, CommandRunner } from '../agents/command-runner.ts';
import type { Clock } from '../scheduler/clock.ts';
import {
  type AttemptMount,
  type AttemptSpawnContext,
  type CampaignChildSpec,
  type ChildExitInfo,
  type ChildSpawner,
  type SpawnedCampaignChild,
  SpawnError,
} from './spawn.ts';
import { COVERED_BY_LOCK_ENV } from './locks.ts';

export const ATTEMPT_TMPFS_BYTES = 2 * 1024 * 1024 * 1024;
export const ATTEMPT_RUNTIME_DIR = '/run/quorum/attempt';

export class AttemptContainerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AttemptContainerError';
  }
}

/** The async `docker wait` seam: the synchronous CommandRunner would block
 *  the controller's event loop (heartbeats, other attempts) for the whole
 *  attempt, so the long-blocking wait is injected separately. Default
 *  implementation wraps Bun.spawn. */
export type DockerWait = (containerId: string) => Promise<number>;

export const realDockerWait: DockerWait = async (containerId) => {
  const proc = Bun.spawn(['docker', 'wait', containerId], {
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const code = await proc.exited;
  const stderr = await new Response(proc.stderr).text();
  if (code !== 0) {
    throw new AttemptContainerError(
      `docker wait failed for ${containerId}: ${stderr.trim()}`,
    );
  }
  return Number((await new Response(proc.stdout).text()).trim());
};

export interface ContainerAttemptSpawnerArgs {
  readonly runner: CommandRunner;
  readonly clock: Clock;
  readonly stream: { write(s: string): void };
  readonly campaignId: string;
  readonly campaignDir: string;
  readonly imageRef: string;
  readonly imageDigest: string;
  readonly evalsSha: string;
  /** The appliance bundle the per-attempt credential projection reads
   *  (Task 6 wiring). */
  readonly bundleDir: string;
  readonly uid: number;
  readonly gid: number;
  readonly dockerWait?: DockerWait;
  readonly tmpfsBytes?: number;
}

export interface BuildAttemptMountsArgs {
  readonly evalsRoot: string;
  readonly gauntletRoot: string;
  readonly binRoot: string;
  readonly superpowersTree: string | null;
  readonly attemptDir: string;
  readonly subjectEnvFile: string;
  readonly graderEnvFile: string;
  readonly passwdFile: string;
  readonly groupFile: string;
}

/** The one audited mount list (child 1 spec, "Container spawner"). Frozen
 *  trees keep their host paths inside the container so every path the
 *  dispatcher already computes is valid unchanged. */
export function buildAttemptMounts(args: BuildAttemptMountsArgs): AttemptMount[] {
  const mounts: AttemptMount[] = [
    { source: args.evalsRoot, target: args.evalsRoot, mode: 'ro' },
    { source: args.gauntletRoot, target: args.gauntletRoot, mode: 'ro' },
    { source: args.binRoot, target: args.binRoot, mode: 'ro' },
  ];
  if (args.superpowersTree !== null) {
    mounts.push({
      source: args.superpowersTree,
      target: args.superpowersTree,
      mode: 'ro',
    });
  }
  mounts.push(
    { source: args.attemptDir, target: args.attemptDir, mode: 'rw' },
    { source: args.subjectEnvFile, target: '/run/quorum/subject.env', mode: 'ro' },
    { source: args.graderEnvFile, target: '/run/quorum/grader.env', mode: 'ro' },
    { source: args.passwdFile, target: '/etc/passwd', mode: 'ro' },
    { source: args.groupFile, target: '/etc/group', mode: 'ro' },
  );
  return mounts;
}

interface InspectedMount {
  readonly Type: string;
  readonly Source: string;
  readonly Target: string;
  readonly ReadOnly?: boolean;
}

export class ContainerAttemptSpawner implements ChildSpawner {
  readonly kind = 'container' as const;
  private readonly args: ContainerAttemptSpawnerArgs;
  private readonly dockerWait: DockerWait;

  constructor(args: ContainerAttemptSpawnerArgs) {
    this.args = args;
    this.dockerWait = args.dockerWait ?? realDockerWait;
  }

  spawn(spec: CampaignChildSpec): SpawnedCampaignChild {
    const attempt = spec.attempt;
    if (attempt === undefined) {
      throw new SpawnError(
        'container spawner requires an attempt context on the child spec',
      );
    }
    const id = this.createContainer(spec, attempt);
    this.verifyMounts(id, attempt.mounts);
    this.createLogFiles(attempt);
    const started = this.docker(['start', id]);
    if (started.status !== 0) {
      this.docker(['rm', id]);
      throw new AttemptContainerError(
        `docker start failed for ${id}: ${started.stderr.trim()}`,
      );
    }
    return this.settleHandle(id, attempt);
  }

  private docker(dockerArgs: readonly string[]): CommandResult {
    return this.args.runner.run('docker', [...dockerArgs]);
  }

  private createContainer(
    spec: CampaignChildSpec,
    attempt: AttemptSpawnContext,
  ): string {
    const tmpfs = this.args.tmpfsBytes ?? ATTEMPT_TMPFS_BYTES;
    const argv: string[] = [
      'create',
      '--init',
      '--name',
      `quorum-attempt-${this.args.campaignId}-${attempt.attemptId}`,
      '--label',
      `quorum.campaign_id=${this.args.campaignId}`,
      '--label',
      `quorum.attempt_id=${attempt.attemptId}`,
      '--label',
      `quorum.evals_sha=${this.args.evalsSha}`,
      '--user',
      `${this.args.uid}:${this.args.gid}`,
      '--workdir',
      spec.cwd,
      '--env',
      `HOME=${attempt.homeDir}`,
      '--env',
      `TMPDIR=${ATTEMPT_RUNTIME_DIR}`,
      '--env',
      `TMUX_TMPDIR=${ATTEMPT_RUNTIME_DIR}`,
      '--env',
      `XDG_CONFIG_HOME=${attempt.homeDir}/.config`,
      '--env',
      `XDG_CACHE_HOME=${attempt.homeDir}/.cache`,
      '--env',
      `XDG_STATE_HOME=${attempt.homeDir}/.local/state`,
      '--env',
      `${COVERED_BY_LOCK_ENV}=1`,
      '--env',
      `QUORUM_ATTEMPT_DIR=${attempt.attemptDir}`,
      '--tmpfs',
      `${ATTEMPT_RUNTIME_DIR}:rw,noexec,nosuid,size=${tmpfs}`,
      '--tmpfs',
      `/tmp:rw,size=${tmpfs}`,
    ];
    for (const mount of attempt.mounts) {
      argv.push(
        '--mount',
        `type=bind,source=${mount.source},target=${mount.target}${
          mount.mode === 'ro' ? ',readonly' : ''
        }`,
      );
    }
    argv.push(this.args.imageRef, attempt.entrypoint, ...spec.args);
    const result = this.docker(argv);
    if (result.status !== 0 || result.stdout.trim() === '') {
      throw new AttemptContainerError(
        `docker create failed: ${result.stderr.trim()}`,
      );
    }
    return result.stdout.trim();
  }

  private verifyMounts(
    containerId: string,
    expected: readonly AttemptMount[],
  ): void {
    const result = this.docker(['inspect', containerId]);
    if (result.status !== 0) {
      this.docker(['rm', containerId]);
      throw new AttemptContainerError(
        `docker inspect failed for ${containerId}: ${result.stderr.trim()}`,
      );
    }
    let observed: readonly InspectedMount[];
    try {
      const parsed: unknown = JSON.parse(result.stdout);
      observed = (
        parsed as { HostConfig?: { Mounts?: InspectedMount[] } }[]
      )[0]?.HostConfig?.Mounts ?? [];
    } catch {
      this.docker(['rm', containerId]);
      throw new AttemptContainerError(
        `docker inspect returned unparseable output for ${containerId}`,
      );
    }
    const key = (m: { Source: string; Target: string; ReadOnly?: boolean; Type?: string }) =>
      `${m.Type ?? 'bind'}|${m.Source}|${m.Target}|${m.ReadOnly === true}`;
    const expectedKeys = new Set(
      expected.map((m) => key({ Source: m.source, Target: m.target, ReadOnly: m.mode === 'ro' })),
    );
    const observedKeys = observed.map((m) => key(m));
    const extra = observedKeys.filter((k) => !expectedKeys.has(k));
    const missing = [...expectedKeys].filter((k) => !observedKeys.includes(k));
    if (extra.length > 0 || missing.length > 0) {
      this.docker(['rm', containerId]);
      throw new AttemptContainerError(
        `mount verification failed for ${containerId}: extra=[${extra.join(', ')}] missing=[${missing.join(', ')}] — removed the exact container`,
      );
    }
  }

  private createLogFiles(attempt: AttemptSpawnContext): void {
    for (const path of [attempt.stdoutLog, attempt.stderrLog]) {
      const fd = openSync(path, 'a', 0o600);
      closeSync(fd);
    }
  }

  private settleHandle(
    containerId: string,
    attempt: AttemptSpawnContext,
  ): SpawnedCampaignChild {
    // Task 3 replaces this stub with the follow/wait/exit lifecycle.
    const stdoutLines: string[] = [];
    const stderrLines: string[] = [];
    const exitCbs: ((info: ChildExitInfo) => void)[] = [];
    void containerId;
    void attempt;
    void this.dockerWait;
    return {
      handle: {
        kind: 'container',
        containerId,
        imageDigest: this.args.imageDigest,
      },
      get stdoutLines() {
        return [...stdoutLines];
      },
      get stderrLines() {
        return [...stderrLines];
      },
      onStdoutLine(cb) {
        for (const line of stdoutLines) cb(line);
      },
      onStderrLine(cb) {
        for (const line of stderrLines) cb(line);
      },
      onExit(cb) {
        exitCbs.push(cb);
      },
    };
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun test test/campaign-container-spawner.test.ts`
Expected: PASS.

- [ ] **Step 5: Run the full gate**

Run: `bun run check && bun run quorum check && git diff --check`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/campaign/container-spawner.ts test/campaign-container-spawner.test.ts
git commit -m "feat(campaign): add the container attempt spawner create path"
```

---

### Task 3: Durable log following, wait, exit.json, and latched settlement

**Files:**
- Modify: `src/campaign/container-spawner.ts` (replace the `settleHandle` stub)
- Test: `test/campaign-container-spawner.test.ts` (append)

**Interfaces:**
- Consumes: `AttemptSpawnContext`, `ChildExitInfo`, `Clock`, `DockerWait`.
- Produces: full `SpawnedCampaignChild` latch-and-replay semantics on the container path; `exit.json` written to the attempt directory before exit publication.

- [ ] **Step 1: Write the failing tests**

Append to `test/campaign-container-spawner.test.ts` (plus `import { mkdtempSync, writeFileSync, appendFileSync, readFileSync } from 'node:fs'; import { tmpdir } from 'node:os'; import { join } from 'node:path'; import type { ChildExitInfo } from '../src/campaign/spawn.ts';`). All three tests share one harness, defined in full first:

```typescript
interface FollowHarness {
  readonly attempt: NonNullable<CampaignChildSpec['attempt']>;
  readonly clock: FakeClock;
  readonly runner: FakeDocker;
  readonly child: ReturnType<ContainerAttemptSpawner['spawn']>;
  readonly endWait: (code: number) => void;
  readonly tick: () => Promise<void>;
}

function followHarness(opts: {
  exitCode?: number;
  oomKilled?: boolean;
  inspectState?: unknown;
}): FollowHarness {
  const dir = mkdtempSync(join(tmpdir(), 'spawner-follow-'));
  const attempt = attemptCtx({
    attemptDir: dir,
    stdoutLog: join(dir, 'stdout.log'),
    stderrLog: join(dir, 'stderr.log'),
    homeDir: join(dir, 'home'),
    mounts: [], // mount verification is covered by the Task 2 tests
  });
  writeFileSync(attempt.stdoutLog, '');
  writeFileSync(attempt.stderrLog, '');
  const clock = new FakeClock();
  let endWait: (code: number) => void = () => {};
  const waited = new Promise<number>((r) => (endWait = r));
  const runner = new FakeDocker();
  const id = '1'.repeat(64);
  const inspectResult = (): CommandResult => ({
    status: 0,
    stdout: JSON.stringify([
      {
        HostConfig: { Mounts: [] },
        State: opts.inspectState ?? {
          Running: false,
          ExitCode: opts.exitCode ?? 0,
          OOMKilled: opts.oomKilled ?? false,
          StartedAt: '2026-09-02T00:00:00Z',
          FinishedAt: '2026-09-02T00:01:00Z',
        },
      },
    ]),
    stderr: '',
  });
  runner.results.push(() => ({ status: 0, stdout: `${id}\n`, stderr: '' })); // create
  runner.results.push(inspectResult); // verifyMounts (pre-start)
  // `docker start` falls through to FakeDocker's default success result.
  runner.results.push(inspectResult); // post-wait exit inspection
  const spawner = new ContainerAttemptSpawner({
    runner,
    clock,
    stream: { write: () => {} },
    campaignId: 'c'.repeat(64),
    campaignDir: '/camp',
    imageRef: 'superpowers-evals:local',
    imageDigest: `sha256:${'b'.repeat(64)}`,
    evalsSha: 'd'.repeat(40),
    bundleDir: '/bundle',
    uid: 1,
    gid: 1,
    dockerWait: () => waited,
  });
  const child = spawner.spawn({ command: 'bun', args: [], cwd: '/camp/evals', env: {}, attempt });
  // One fake-clock poll plus a microtask flush; deterministic on any host.
  const tick = async (): Promise<void> => {
    clock.advance(0.05);
    await new Promise((r) => setTimeout(r, 0));
  };
  return { attempt, clock, runner, child, endWait, tick };
}

test('line delivery: latch before a late subscriber, tail flushed once at exit', async () => {
  const h = followHarness({});
  appendFileSync(h.attempt.stdoutLog, 'run_allocated: run-9\npartial');
  await h.tick();
  appendFileSync(h.attempt.stdoutLog, '-tail\n');
  h.endWait(0);
  await h.tick();
  await h.tick();
  const seen: string[] = [];
  h.child.onStdoutLine((l) => seen.push(l)); // late subscriber replays the latch
  expect(seen).toEqual(['run_allocated: run-9', 'partial-tail']);
  const exit = await new Promise<ChildExitInfo>((r) => h.child.onExit(r));
  expect(exit).toEqual({ code: 0, signal: null });
});

test('exit publication waits for both files to reach EOF', async () => {
  const h = followHarness({});
  appendFileSync(h.attempt.stderrLog, 'err-1\nerr-2\n');
  let exitFired = 0;
  h.child.onExit(() => { exitFired += 1; });
  h.endWait(0);
  await h.tick(); // wait completed but stderr not yet drained
  expect(exitFired).toBe(0);
  const errSeen: string[] = [];
  h.child.onStderrLine((l) => errSeen.push(l));
  await h.tick(); // drains stderr to EOF, settles exactly once
  await h.tick(); // a further poll must not re-settle
  expect(errSeen).toEqual(['err-1', 'err-2']);
  expect(exitFired).toBe(1);
});

test('exit.json carries code, oom flag, and timestamps', async () => {
  const h = followHarness({ exitCode: 137, oomKilled: true });
  h.endWait(137);
  await h.tick();
  await h.tick();
  const exit = await new Promise<ChildExitInfo>((r) => h.child.onExit(r));
  expect(exit).toEqual({ code: 137, signal: 'SIGKILL' });
  const recorded = JSON.parse(readFileSync(join(h.attempt.attemptDir, 'exit.json'), 'utf8')) as {
    code: number; signal: string | null; oom_killed: boolean; started_at: string | null; finished_at: string | null;
  };
  expect(recorded.code).toBe(137);
  expect(recorded.signal).toBe('SIGKILL');
  expect(recorded.oom_killed).toBe(true);
  expect(recorded.started_at).toBe('2026-09-02T00:00:00Z');
  expect(recorded.finished_at).toBe('2026-09-02T00:01:00Z');
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test test/campaign-container-spawner.test.ts`
Expected: FAIL — the stub delivers no lines and never exits.

- [ ] **Step 3: Implement the follow/wait/settle lifecycle**

Replace `settleHandle` in `src/campaign/container-spawner.ts` with the latched implementation modeled on `DetachedChildSpawner` (`src/campaign/spawn.ts`): identical `stdoutLines`/`stderrLines` latches, replay-on-subscribe, one unterminated tail flushed exactly once, and exit published only after BOTH log files reach EOF. Key pieces:

```typescript
  private settleHandle(
    containerId: string,
    attempt: AttemptSpawnContext,
  ): SpawnedCampaignChild {
    const stdoutLines: string[] = [];
    const stderrLines: string[] = [];
    const stdoutCbs: ((line: string) => void)[] = [];
    const stderrCbs: ((line: string) => void)[] = [];
    const exitCbs: ((info: ChildExitInfo) => void)[] = [];
    let exitInfo: ChildExitInfo | null = null;

    const deliver = (buf: string, lines: string[], cbs: ((l: string) => void)[], chunk: string): string => {
      const next = buf + chunk;
      const parts = next.split('\n');
      const rest = parts.pop() ?? '';
      for (const line of parts) {
        lines.push(line);
        for (const cb of cbs) cb(line);
      }
      return rest;
    };

    const follow = async (): Promise<void> => {
      const stdoutFd = openSync(attempt.stdoutLog, 'r');
      const stderrFd = openSync(attempt.stderrLog, 'r');
      let outOff = 0;
      let errOff = 0;
      let outBuf = '';
      let errBuf = '';
      let waitDone = false;
      let waitCode = 0;
      void this.dockerWait(containerId).then((code) => {
        waitDone = true;
        waitCode = code;
      });
      const buf = Buffer.alloc(64 * 1024);
      for (;;) {
        const outRead = fsReadSync(stdoutFd, buf, 0, buf.length, outOff);
        if (outRead > 0) {
          outOff += outRead;
          outBuf = deliver(outBuf, stdoutLines, stdoutCbs, buf.subarray(0, outRead).toString('utf8'));
        }
        const errRead = fsReadSync(stderrFd, buf, 0, buf.length, errOff);
        if (errRead > 0) {
          errOff += errRead;
          errBuf = deliver(errBuf, stderrLines, stderrCbs, buf.subarray(0, errRead).toString('utf8'));
        }
        if (waitDone && outRead === 0 && errRead === 0) {
          // Flush the unterminated tails exactly once, then settle.
          if (outBuf !== '') { outBuf = deliver(outBuf, stdoutLines, stdoutCbs, '\n'); }
          if (errBuf !== '') { errBuf = deliver(errBuf, stderrLines, stderrCbs, '\n'); }
          break;
        }
        await this.args.clock.sleepUntil(this.args.clock.now() + FOLLOW_POLL_SECONDS);
      }
      closeSync(stdoutFd);
      closeSync(stderrFd);
      const state = this.inspectState(containerId);
      writeFileSync(
        join(attempt.attemptDir, 'exit.json'),
        `${JSON.stringify(
          {
            code: state?.exitCode ?? waitCode,
            signal: state?.oomKilled === true ? 'SIGKILL' : null,
            oom_killed: state?.oomKilled === true,
            started_at: state?.startedAt ?? null,
            finished_at: state?.finishedAt ?? null,
          },
          null,
          2,
        )}\n`,
        { mode: 0o600 },
      );
      exitInfo = {
        code: state?.exitCode ?? waitCode,
        signal: state?.oomKilled === true ? 'SIGKILL' : null,
      };
      for (const cb of exitCbs) cb(exitInfo);
    };
    void follow();

    return { /* same shape as Task 2, with replaying onStdoutLine/onStderrLine
               and onExit replaying exitInfo when already settled */ };
  }
```

Add `inspectState(containerId): { running: boolean; exitCode: number; oomKilled: boolean; startedAt: string; finishedAt: string } | null` — `docker inspect`, parse `State`, return null when the container is absent (non-zero inspect with `No such object`). Import `readSync as fsReadSync`, `closeSync`, `openSync`, `writeFileSync` from `node:fs` and `join` from `node:path`. Define `const FOLLOW_POLL_SECONDS = 0.05;`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun test test/campaign-container-spawner.test.ts`
Expected: PASS.

- [ ] **Step 5: Run the full gate and commit**

Run: `bun run check && bun run quorum check && git diff --check`

```bash
git add src/campaign/container-spawner.ts test/campaign-container-spawner.test.ts
git commit -m "feat(campaign): follow durable attempt logs and settle container exits"
```

---

### Task 4: Container stop routine (verified death by exact container ID)

**Files:**
- Modify: `src/campaign/container-spawner.ts`
- Test: `test/campaign-container-spawner.test.ts` (append)

**Interfaces:**
- Consumes: `Clock`, `CommandRunner`, the `inspectState` helper from Task 3.
- Produces: `ContainerAttemptSpawner.stopContainer(containerId, graceSeconds): Promise<'dead' | 'alive'>` and the exported type `ContainerStopper = { stop(containerId: string, graceSeconds: number): Promise<'dead' | 'alive'> }` (used by the dispatcher in Task 10 and recovery in Task 11).

- [ ] **Step 1: Write the failing tests**

Append to `test/campaign-container-spawner.test.ts`:

```typescript
test('stop: SIGTERM grace, escalation to kill, verified dead; never probes tmux', async () => {
  const runner = new FakeDocker();
  const clock = new FakeClock();
  const id = '9'.repeat(64);
  let running = true;
  runner.results.push(() => ({ status: 0, stdout: '', stderr: '' })); // stop
  // inspect loop: running until after kill
  for (let i = 0; i < 10; i++) {
    runner.results.push(() => ({
      status: 0,
      stdout: JSON.stringify([{ State: { Running: running, ExitCode: 137, OOMKilled: false, StartedAt: 's', FinishedAt: 'f' } }]),
      stderr: '',
    }));
  }
  runner.results.push(() => { running = false; return { status: 0, stdout: '', stderr: '' }; }); // kill
  const spawner = new ContainerAttemptSpawner({ runner, clock, stream: { write: () => {} }, campaignId: 'c'.repeat(64), campaignDir: '/camp', imageRef: 'r', imageDigest: `sha256:${'b'.repeat(64)}`, evalsSha: 'd'.repeat(40), bundleDir: '/bundle', uid: 1, gid: 1 });
  const verdict = spawner.stopContainer(id, 5);
  await Promise.resolve();
  clock.advance(0.05); await Promise.resolve();
  clock.advance(5); await Promise.resolve();
  clock.advance(0.05); await Promise.resolve();
  expect(await verdict).toBe('dead');
  const verbs = runner.calls.map((c) => c.args[0]);
  expect(verbs).toContain('stop');
  expect(verbs).toContain('kill');
  expect(runner.calls.some((c) => c.command === 'tmux')).toBe(false);
});

test('stop: a container that survives kill past the window reports alive', async () => {
  const runner = new FakeDocker();
  const clock = new FakeClock();
  const id = '8'.repeat(64);
  const writes: string[] = [];
  runner.results.push(() => ({ status: 0, stdout: '', stderr: '' })); // stop
  for (let i = 0; i < 80; i++) {
    runner.results.push(() => ({
      status: 0,
      stdout: JSON.stringify([{ State: { Running: true, ExitCode: 0, OOMKilled: false, StartedAt: 's', FinishedAt: 'f' } }]),
      stderr: '',
    })); // every inspect: still running
  }
  runner.results.push(() => ({ status: 0, stdout: '', stderr: '' })); // kill
  const spawner = new ContainerAttemptSpawner({ runner, clock, stream: { write: (s) => writes.push(s) }, campaignId: 'c'.repeat(64), campaignDir: '/camp', imageRef: 'r', imageDigest: `sha256:${'b'.repeat(64)}`, evalsSha: 'd'.repeat(40), bundleDir: '/bundle', uid: 1, gid: 1 });
  const verdict = spawner.stopContainer(id, 1);
  for (let i = 0; i < 60; i++) { clock.advance(0.05); await Promise.resolve(); }
  expect(await verdict).toBe('alive');
  expect(writes.some((w) => w.includes(id) && w.includes('FAILED'))).toBe(true);
});

test('stop: an absent container is already dead', async () => {
  const runner = new FakeDocker();
  const clock = new FakeClock();
  const id = '7'.repeat(64);
  runner.results.push(() => ({ status: 0, stdout: '', stderr: '' })); // stop
  runner.results.push(() => ({ status: 1, stdout: '', stderr: 'Error: No such object: ' + id })); // inspect
  const spawner = new ContainerAttemptSpawner({ runner, clock, stream: { write: () => {} }, campaignId: 'c'.repeat(64), campaignDir: '/camp', imageRef: 'r', imageDigest: `sha256:${'b'.repeat(64)}`, evalsSha: 'd'.repeat(40), bundleDir: '/bundle', uid: 1, gid: 1 });
  expect(await spawner.stopContainer(id, 1)).toBe('dead');
  const verbs = runner.calls.map((c) => c.args[0]);
  expect(verbs).not.toContain('kill');
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test test/campaign-container-spawner.test.ts`
Expected: FAIL — `stopContainer` missing.

- [ ] **Step 3: Implement stopContainer**

Add to `ContainerAttemptSpawner`:

```typescript
  async stopContainer(
    containerId: string,
    graceSeconds: number,
  ): Promise<'dead' | 'alive'> {
    const pollSeconds = 0.05;
    const verifiedDead = async (deadline: number): Promise<boolean> => {
      for (;;) {
        const state = this.inspectState(containerId);
        if (state === null || state.running === false) return true;
        if (this.args.clock.now() >= deadline) return false;
        await this.args.clock.sleepUntil(this.args.clock.now() + pollSeconds);
      }
    };
    const stopped = this.docker([
      'stop',
      '--time',
      String(Math.max(1, Math.floor(graceSeconds))),
      containerId,
    ]);
    if (stopped.status !== 0 && !/no such container/i.test(stopped.stderr)) {
      this.args.stream.write(
        `docker stop ${containerId} failed: ${stopped.stderr.trim()} — continuing to verify\n`,
      );
    }
    if (await verifiedDead(this.args.clock.now() + graceSeconds)) return 'dead';
    const killed = this.docker(['kill', containerId]);
    if (killed.status !== 0 && !/no such container/i.test(killed.stderr)) {
      this.args.stream.write(
        `docker kill ${containerId} failed: ${killed.stderr.trim()} — continuing to verify\n`,
      );
    }
    if (await verifiedDead(this.args.clock.now() + graceSeconds)) return 'dead';
    this.args.stream.write(
      `container ${containerId} survived stop+kill past ${graceSeconds}s grace — verify-death FAILED; abort the enclosing operation loudly\n`,
    );
    return 'alive';
  }
```

Export:

```typescript
export interface ContainerStopper {
  stop(containerId: string, graceSeconds: number): Promise<'dead' | 'alive'>;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun test test/campaign-container-spawner.test.ts`
Expected: PASS.

- [ ] **Step 5: Run the full gate and commit**

Run: `bun run check && bun run quorum check && git diff --check`

```bash
git add src/campaign/container-spawner.ts test/campaign-container-spawner.test.ts
git commit -m "feat(campaign): verify attempt death by exact container id"
```

---

### Task 5: The attempt entrypoint

**Files:**
- Create: `container/attempt-entrypoint.sh`
- Test: `test/campaign-attempt-entrypoint.test.ts`

**Interfaces:**
- Consumes: `QUORUM_ATTEMPT_DIR` env (set by the spawner's `docker create`), the two `0400` credential files at `/run/quorum/subject.env` and `/run/quorum/grader.env`.
- Produces: the container command target: appends stdio to the durable logs, sources both deliveries (`set -a`), `exec bun "$@"`.

- [ ] **Step 1: Write the failing test**

Create `test/campaign-attempt-entrypoint.test.ts`:

```typescript
import { expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const entrypoint = resolve('container/attempt-entrypoint.sh');

test('entrypoint: appends stdio to the durable logs, sources deliveries, execs bun argv', async () => {
  const attempt = mkdtempSync(join(tmpdir(), 'attempt-entry-'));
  const subject = join(attempt, 'subject.env');
  const grader = join(attempt, 'grader.env');
  writeFileSync(subject, 'SUBJECT_KEY=subject-value\n');
  writeFileSync(grader, 'QUORUM_GRADER_API_KEY=grader-value\n');
  writeFileSync(join(attempt, 'stdout.log'), 'pre-existing\n');
  writeFileSync(join(attempt, 'stderr.log'), '');
  // A bun-executable probe: the entrypoint `exec bun "$@"`, so the probe
  // must be a script bun can run (the production argv is src/cli/index.ts).
  const probe = join(attempt, 'probe.ts');
  writeFileSync(
    probe,
    'console.log(`subject=${process.env.SUBJECT_KEY} grader=${process.env.QUORUM_GRADER_API_KEY}`);\nconsole.error("err-line");\nprocess.exit(3);\n',
  );
  const proc = Bun.spawn(['bash', entrypoint, probe], {
    env: {
      PATH: process.env.PATH ?? '',
      QUORUM_ATTEMPT_DIR: attempt,
      QUORUM_SUBJECT_FILE: subject,
      QUORUM_GRADER_FILE: grader,
    },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  expect(await proc.exited).toBe(3); // the exec'd command's status propagates
  const stdout = readFileSync(join(attempt, 'stdout.log'), 'utf8');
  const stderr = readFileSync(join(attempt, 'stderr.log'), 'utf8');
  expect(stdout).toBe('pre-existing\nsubject=subject-value grader=grader-value\n');
  expect(stderr).toBe('err-line\n');
  // the caller's own pipes received nothing — all output went to the logs
  expect(await new Response(proc.stdout).text()).toBe('');
});

test('entrypoint: refuses to run without QUORUM_ATTEMPT_DIR', async () => {
  const proc = Bun.spawn(['bash', entrypoint, 'true'], {
    env: { PATH: process.env.PATH ?? '' },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  expect(await proc.exited).not.toBe(0);
});
```

The entrypoint reads the delivery paths from `QUORUM_SUBJECT_FILE` / `QUORUM_GRADER_FILE` so the portable test can point at tmp files; the spawner sets them to the fixed in-container paths `/run/quorum/subject.env` / `/run/quorum/grader.env` (add both `--env` entries to `createContainer`'s allowlist in this step, and extend Task 2's argv test accordingly).

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test test/campaign-attempt-entrypoint.test.ts`
Expected: FAIL — the script does not exist.

- [ ] **Step 3: Implement the entrypoint**

Create `container/attempt-entrypoint.sh`:

```bash
#!/usr/bin/env bash
# Campaign Appliance V2 attempt entrypoint. Ships in the frozen evals
# snapshot; the container's command is this script followed by the
# dispatcher's argv. PID 1 is Docker's bundled init; after the exec below
# the tree is init -> bun (Quorum).
set -euo pipefail

umask 077

: "${QUORUM_ATTEMPT_DIR:?QUORUM_ATTEMPT_DIR is required}"

# The controller created both logs mode 0600 before docker start; the
# entrypoint only appends, never creates or truncates.
exec >> "$QUORUM_ATTEMPT_DIR/stdout.log" 2>> "$QUORUM_ATTEMPT_DIR/stderr.log"

# Deliveries are controller-written NAME=value files, mode 0400. Shell
# sourcing is the deliberate child-1 model (the Phase 1 shim does the same
# with /run/evals/credentials.env); child 4 replaces it with non-shell
# parsing.
for delivery in "${QUORUM_SUBJECT_FILE:-/run/quorum/subject.env}" \
  "${QUORUM_GRADER_FILE:-/run/quorum/grader.env}"; do
  if [[ -f "$delivery" ]]; then
    set -a
    # shellcheck disable=SC1090
    source "$delivery"
    set +a
  fi
done

exec bun "$@"
```

Then: `chmod +x container/attempt-entrypoint.sh`. Add the two `--env` entries (`QUORUM_SUBJECT_FILE=/run/quorum/subject.env`, `QUORUM_GRADER_FILE=/run/quorum/grader.env`) to `createContainer` and extend the Task 2 argv assertions to expect them.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun test test/campaign-attempt-entrypoint.test.ts test/campaign-container-spawner.test.ts`
Expected: PASS.

- [ ] **Step 5: Run the full gate and commit**

Run: `bun run check && bun run quorum check && git diff --check`

```bash
git add container/attempt-entrypoint.sh test/campaign-attempt-entrypoint.test.ts src/campaign/container-spawner.ts test/campaign-container-spawner.test.ts
git commit -m "feat(campaign): add the attempt container entrypoint"
```

---

### Task 6: Credential projection to the per-attempt stage

**Files:**
- Modify: `src/appliance/credential-scope.ts` (exports only)
- Create: `src/campaign/attempt-projection.ts`
- Test: `test/campaign-attempt-projection.test.ts`

**Interfaces:**
- Consumes: `credentialScopeForSelection` (`src/credentials/scope.ts`), the credential-scope internals exported in Step 3, `LiveCredentialScope`.
- Produces: `prepareAttemptStage`, `removeAttemptStage`, `PreparedAttemptStage`, `AttemptProjectionError`. The container spawner (Task 10 wiring) consumes `PreparedAttemptStage`.

- [ ] **Step 1: Write the failing tests**

Create `test/campaign-attempt-projection.test.ts`. The fixture mirrors `test/appliance-credential-scope.test.ts` (read that file's corpus/bundle builders first and reuse their exact yaml shapes): a tmp corpus with `coding-agents/claude.yaml` (one claude-family agent) and `credentials.yaml` declaring `cred_a: { auth: api-key, api_key_env: SUBJECT_KEY, harnesses: [claude] }`, plus a tmp bundle dir containing `credentials.env`:

```typescript
import { expect, test } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AttemptProjectionError, prepareAttemptStage, removeAttemptStage } from '../src/campaign/attempt-projection.ts';

/** Corpus + bundle exactly as test/appliance-credential-scope.test.ts builds
 *  them (copy its yaml bodies); the grader sources are the QUORUM_GRADER_*
 *  aliases Phase 1 stages into supervisor.exec.env. */
function projectionFixture(opts: { sharedSecret?: boolean } = {}) {
  const corpus = mkdtempSync(join(tmpdir(), 'projection-corpus-'));
  const campaignDir = mkdtempSync(join(tmpdir(), 'projection-camp-'));
  const bundleDir = mkdtempSync(join(tmpdir(), 'projection-bundle-'));
  mkdirSync(join(corpus, 'coding-agents'), { recursive: true });
  writeFileSync(join(corpus, 'coding-agents', 'claude.yaml'), /* copy from the scope tests */ '');
  writeFileSync(
    join(corpus, 'credentials.yaml'),
    'credentials:\n  cred_a:\n    auth: api-key\n    api_key_env: SUBJECT_KEY\n    harnesses:\n      - claude\n',
  );
  const subject = 'subject-secret-value';
  const grader = opts.sharedSecret === true ? subject : 'grader-secret-value';
  writeFileSync(
    join(bundleDir, 'credentials.env'),
    `SUBJECT_KEY=${subject}\nQUORUM_GRADER_API_KEY=${grader}\nQUORUM_GRADER_SOURCE_MODE=appliance-scoped\n`,
  );
  return { corpus, campaignDir, bundleDir, subject, grader };
}

test('projection writes exactly the expected names, 0400 under a 0700 stage', () => {
  const fx = projectionFixture();
  const prepared = prepareAttemptStage({
    campaignDir: fx.campaignDir,
    attemptId: 'c1:s:arm_a:r1:a1',
    agent: 'claude',
    credentialName: 'cred_a',
    evalsRoot: fx.corpus,
    bundleDir: fx.bundleDir,
    uid: 1000,
    gid: 1000,
  });
  expect(readFileSync(prepared.subjectEnvFile, 'utf8')).toBe(`SUBJECT_KEY=${fx.subject}\n`);
  const graderBody = readFileSync(prepared.graderEnvFile, 'utf8');
  expect(graderBody).toContain('QUORUM_GRADER_SOURCE_MODE=appliance-scoped');
  expect(graderBody).toContain(`QUORUM_GRADER_API_KEY=${fx.grader}`);
  expect((statSync(prepared.subjectEnvFile).mode & 0o777)).toBe(0o400);
  expect((statSync(prepared.graderEnvFile).mode & 0o777)).toBe(0o400);
  expect((statSync(prepared.stageDir).mode & 0o777)).toBe(0o700);
  expect(existsSync(join(prepared.attemptDir, 'staging'))).toBe(true);
  expect(existsSync(join(prepared.attemptDir, 'home'))).toBe(true);
});

test('projection refuses subject/grader value equality without printing either value', () => {
  const fx = projectionFixture({ sharedSecret: true });
  let caught: unknown;
  try {
    prepareAttemptStage({
      campaignDir: fx.campaignDir,
      attemptId: 'a',
      agent: 'claude',
      credentialName: 'cred_a',
      evalsRoot: fx.corpus,
      bundleDir: fx.bundleDir,
      uid: 1000,
      gid: 1000,
    });
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(AttemptProjectionError);
  const message = (caught as Error).message;
  expect(message).not.toContain(fx.subject); // values never printed
  expect(existsSync(join(fx.campaignDir, 'attempts', 'a', '.stage'))).toBe(false);
});

test('projection refuses an OAuth-requiring cell typed', () => {
  // Fixture variant: declare cred_oauth with `auth: oauth` under the claude
  // family (delivery exists but needs an OAuth home) and cred_sub with
  // `auth: subscription` (no audited delivery channel at all).
  const fx = projectionFixture();
  writeFileSync(
    join(fx.corpus, 'credentials.yaml'),
    'credentials:\n  cred_oauth:\n    auth: oauth\n    harnesses:\n      - claude\n  cred_sub:\n    auth: subscription\n    harnesses:\n      - claude\n',
  );
  expect(() =>
    prepareAttemptStage({ campaignDir: fx.campaignDir, attemptId: 'a', agent: 'claude', credentialName: 'cred_oauth', evalsRoot: fx.corpus, bundleDir: fx.bundleDir, uid: 1000, gid: 1000 }),
  ).toThrow(/OAuth home/);
  expect(() =>
    prepareAttemptStage({ campaignDir: fx.campaignDir, attemptId: 'b', agent: 'claude', credentialName: 'cred_sub', evalsRoot: fx.corpus, bundleDir: fx.bundleDir, uid: 1000, gid: 1000 }),
  ).toThrow(AttemptProjectionError);
});

test('removeAttemptStage removes exactly the stage directory', () => {
  const fx = projectionFixture();
  const prepared = prepareAttemptStage({
    campaignDir: fx.campaignDir,
    attemptId: 'a',
    agent: 'claude',
    credentialName: 'cred_a',
    evalsRoot: fx.corpus,
    bundleDir: fx.bundleDir,
    uid: 1000,
    gid: 1000,
  });
  writeFileSync(prepared.stdoutLog, 'keep me\n');
  removeAttemptStage(prepared.attemptDir);
  expect(existsSync(prepared.stageDir)).toBe(false);
  expect(existsSync(prepared.stdoutLog)).toBe(true);
  expect(existsSync(join(prepared.attemptDir, 'staging'))).toBe(true);
});
```

(The `claude.yaml` body must be copied verbatim from `test/appliance-credential-scope.test.ts` — do not invent the agent-config schema.)

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test test/campaign-attempt-projection.test.ts`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Export the reusable projection internals (no behavior change)**

In `src/appliance/credential-scope.ts`, add the `export` keyword to `selectAgentEnv`, `buildSupervisorEnv`, `assertDistinctFromGraderAuth`, and `evaluateBundleEnv` (verify each name against the module; they are the four functions `stageLiveCredentialMaterial` calls between reading the bundle env and writing the staged files). Extract the pinned bundle read into one exported helper:

```typescript
/** Read one bundle source through a single pinned generation and evaluate
 *  the requested names. Attempt projection (src/campaign/attempt-projection.ts)
 *  reuses this so the campaign path and Phase 1 staging read the bundle the
 *  exact same way. */
export function readBundleEnvForProjection(
  bundleDir: string,
  names: readonly string[],
): ReadonlyMap<string, string> {
  const bundlePin = pinAbsoluteDir(bundleDir, 'credential bundle');
  let envContent: string | null;
  try {
    envContent = readBundleSource(bundlePin, 'credentials.env', true);
  } finally {
    closePin(bundlePin);
  }
  if (envContent === null) {
    throw scopeError('credential bundle is missing credentials.env');
  }
  return evaluateBundleEnv(envContent, [...names]);
}
```

Then refactor `stageLiveCredentialMaterial` to call `readBundleEnvForProjection` (identical behavior; its tests must stay green). Also export the name-set builder used by staging (`GRADER_SOURCE_ENV_BY_RUNTIME_NAME`, `SUPERVISOR_NETWORK_ENV_NAMES`, `COPILOT_SUPERVISOR_ENV_NAMES` are already module constants; export them if not).

- [ ] **Step 4: Implement attempt-projection.ts**

Create `src/campaign/attempt-projection.ts`:

```typescript
import { chmodSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  assertDistinctFromGraderAuth,
  buildSupervisorEnv,
  readBundleEnvForProjection,
  selectAgentEnv,
} from '../appliance/credential-scope.ts';
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
  /** The campaign's frozen evals snapshot — its coding-agents/ and
   *  credentials.yaml are the corpus the scope resolves against. */
  readonly evalsRoot: string;
  /** The appliance bundle named by the config. */
  readonly bundleDir: string;
  readonly uid: number;
  readonly gid: number;
}

export function prepareAttemptStage(
  args: PrepareAttemptStageArgs,
): PreparedAttemptStage {
  const attemptDir = join(args.campaignDir, 'attempts', args.attemptId);
  const stageDir = join(attemptDir, '.stage');
  // Resolve the subject scope against the FROZEN corpus. A delivery channel
  // that needs an OAuth home has no V2 projection (api-key/bedrock-bearer
  // only) and refuses here, before any file exists.
  const scope = (() => {
    try {
      return credentialScopeForSelection(args.evalsRoot, {
        agent: args.agent,
        credential: args.credentialName,
      });
    } catch (error) {
      throw new AttemptProjectionError(
        `attempt ${args.attemptId}: credential scope refused (${
          error instanceof Error ? error.message : String(error)
        })`,
      );
    }
  })();
  if (scope.oauth !== null) {
    throw new AttemptProjectionError(
      `attempt ${args.attemptId}: credential '${scope.credential}' requires an OAuth home projection — V2 accepts only api-key and bedrock-bearer deliveries`,
    );
  }
  const names = new Set<string>();
  for (const projection of scope.agentEnv) {
    for (const source of projection.sourceNames) names.add(source);
  }
  names.add('GEMINI_AUTH_TYPE');
  // The grader delivery is the bundle's QUORUM_GRADER_* aliases — the same
  // material Phase 1 stages into supervisor.exec.env.
  const bundleEnv = readBundleEnvForProjection(args.bundleDir, [...names]);
  const agent = selectAgentEnv(scope, bundleEnv);
  const supervisor = buildSupervisorEnv(scope, bundleEnv);
  // All-pairs distinctness BEFORE either file exists; values are never
  // printed, hashed, or serialized.
  assertDistinctFromGraderAuth(agent.secrets, supervisor.graderAuthValues);

  mkdirSync(attemptDir, { recursive: true, mode: 0o700 });
  mkdirSync(join(attemptDir, 'home'), { recursive: true, mode: 0o700 });
  mkdirSync(join(attemptDir, 'staging'), { recursive: true, mode: 0o700 });
  mkdirSync(stageDir, { recursive: true, mode: 0o700 });
  chmodSync(stageDir, 0o700);

  const subjectEnvFile = join(stageDir, 'subject.env');
  const graderEnvFile = join(stageDir, 'grader.env');
  writeFileSync(
    subjectEnvFile,
    agent.entries.map(([n, v]) => `${n}=${v}`).join('\n') + '\n',
    { mode: 0o400 },
  );
  writeFileSync(graderEnvFile, `${supervisor.lines.join('\n')}\n`, {
    mode: 0o400,
  });
  chmodSync(subjectEnvFile, 0o400);
  chmodSync(graderEnvFile, 0o400);

  // Synthesized identity files for --user, same format as
  // scripts/evals-container.
  const passwdFile = join(stageDir, 'passwd');
  const groupFile = join(stageDir, 'group');
  writeFileSync(
    passwdFile,
    `root:x:0:0:root:/root:/bin/bash\nquorum:x:${args.uid}:${args.gid}:Quorum Attempt:${join(attemptDir, 'home')}:/bin/bash\n`,
    { mode: 0o644 },
  );
  writeFileSync(groupFile, `root:x:0:\nquorum:x:${args.gid}:\n`, {
    mode: 0o644,
  });

  return {
    attemptId: args.attemptId,
    attemptDir,
    stageDir,
    subjectEnvFile,
    graderEnvFile,
    homeDir: join(attemptDir, 'home'),
    stdoutLog: join(attemptDir, 'stdout.log'),
    stderrLog: join(attemptDir, 'stderr.log'),
    stagingDir: join(attemptDir, 'staging'),
    passwdFile,
    groupFile,
  };
}

/** Called after the container is confirmed stopped AND the attempt's
 *  terminal event is journaled (child 2 adds reconciliation removal for a
 *  dead controller between those steps). */
export function removeAttemptStage(attemptDir: string): void {
  rmSync(join(attemptDir, '.stage'), { recursive: true, force: true });
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `bun test test/campaign-attempt-projection.test.ts test/appliance-credential-scope.test.ts`
Expected: PASS (projection tests green; Phase 1 scoping unchanged).

- [ ] **Step 6: Run the full gate and commit**

Run: `bun run check && bun run quorum check && git diff --check`

```bash
git add src/appliance/credential-scope.ts src/campaign/attempt-projection.ts test/campaign-attempt-projection.test.ts
git commit -m "feat(campaign): project exact per-attempt credentials to a private stage"
```

---

### Task 7: Worker-side manifest writer

**Files:**
- Create: `src/runner/manifest.ts`
- Modify: `src/runner/index.ts` (one call site)
- Test: `test/runner-manifest.test.ts`

**Interfaces:**
- Consumes: `CampaignIdentity` (`src/contracts/campaign/campaign.ts`).
- Produces: `writeAttemptManifest(runDir, campaign)`, `AttemptManifest` shape, `parseAttemptManifest(raw)` (used by Task 8's publisher).

- [ ] **Step 1: Write the failing tests**

Create `test/runner-manifest.test.ts`:

```typescript
import { expect, test } from 'bun:test';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseAttemptManifest, writeAttemptManifest } from '../src/runner/manifest.ts';

const identity = {
  campaign_id: 'c'.repeat(64),
  comparison_id: 'c1',
  block_id: 'c1:s:b1',
  sample_id: 'c1:s:arm_a:r1',
  execution_attempt_id: 'c1:s:arm_a:r1:a1',
};

test('manifest lists every artifact with correct digests and is written last', () => {
  const runDir = mkdtempSync(join(tmpdir(), 'manifest-'));
  writeFileSync(join(runDir, 'verdict.json'), '{"final":"pass"}\n');
  mkdirSync(join(runDir, 'home'));
  writeFileSync(join(runDir, 'home', 'secret.env'), 'KEY=v\n');
  mkdirSync(join(runDir, 'gauntlet-agent'), { recursive: true });
  writeFileSync(join(runDir, 'gauntlet-agent', 'result.json'), '{}\n');
  writeAttemptManifest(runDir, identity);
  const manifest = parseAttemptManifest(readFileSync(join(runDir, 'manifest.json'), 'utf8'));
  const paths = manifest.files.map((f) => f.path).sort();
  expect(paths).toEqual(['gauntlet-agent/result.json', 'verdict.json']); // home/ never listed
  for (const file of manifest.files) {
    expect(file.sha256).toBe(
      createHash('sha256').update(readFileSync(join(runDir, file.path))).digest('hex'),
    );
    expect(file.size).toBe(statSync(join(runDir, file.path)).size);
  }
  expect(manifest.campaign).toEqual(identity);
  expect(manifest.schema_version).toBe(1);
});

test('manifest refuses a run dir containing a symlinked artifact', () => {
  // symlink verdict.json -> outside file; expect a thrown RunnerError naming
  // the path; no manifest.json written.
});

test('parseAttemptManifest rejects path traversal and absolute entries', () => {
  // hand-crafted manifests with '../x' and '/abs' entries refuse.
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test test/runner-manifest.test.ts`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement manifest.ts**

Create `src/runner/manifest.ts`:

```typescript
import {
  closeSync,
  fsyncSync,
  lstatSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { join, relative } from 'node:path';
import { z } from 'zod';
import {
  type CampaignIdentity,
  CampaignIdentitySchema,
} from '../contracts/campaign/campaign.ts';
import { RunnerError } from './errors.ts';

export const AttemptManifestSchema = z.object({
  schema_version: z.literal(1),
  campaign: CampaignIdentitySchema,
  files: z
    .array(
      z.object({
        path: z
          .string()
          .min(1)
          .refine((p) => !p.startsWith('/') && !p.split('/').includes('..'), {
            message: 'manifest paths must be relative and contained',
          }),
        size: z.number().int().nonnegative(),
        sha256: z.string().regex(/^[0-9a-f]{64}$/),
      }),
    ),
});
export type AttemptManifest = z.infer<typeof AttemptManifestSchema>;

export function parseAttemptManifest(raw: string): AttemptManifest {
  return AttemptManifestSchema.parse(JSON.parse(raw));
}

const MANIFEST_NAME = 'manifest.json';
const EXCLUDED_DIRS = new Set(['home']);

function collectFiles(runDir: string): string[] {
  const found: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      const rel = relative(runDir, full);
      if (entry.isSymbolicLink()) {
        throw new RunnerError(
          `attempt manifest: symlinked artifact refused: ${rel}`,
          'capture',
        );
      }
      if (entry.isDirectory()) {
        if (dir === runDir && EXCLUDED_DIRS.has(entry.name)) continue;
        walk(full);
        continue;
      }
      if (!entry.isFile()) {
        throw new RunnerError(
          `attempt manifest: non-regular artifact refused: ${rel}`,
          'capture',
        );
      }
      if (rel === MANIFEST_NAME) continue;
      found.push(rel);
    }
  };
  walk(runDir);
  return found.sort();
}

/** The run's final act when a campaign identity is present: fsync every
 *  artifact (read-only fd), digest it, then write the manifest through
 *  temp+fsync+rename and fsync the run directory. Worker exit is NOT
 *  completion — the host verifies this manifest before publication. */
export function writeAttemptManifest(
  runDir: string,
  campaign: CampaignIdentity,
): void {
  const identity = CampaignIdentitySchema.parse(campaign);
  const files = collectFiles(runDir).map((path) => {
    const full = join(runDir, path);
    const fd = openSync(full, 'r');
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    const bytes = readFileSync(full);
    return {
      path,
      size: statSync(full).size,
      sha256: createHash('sha256').update(bytes).digest('hex'),
    };
  });
  const manifest = { schema_version: 1, campaign: identity, files } as const;
  const body = `${JSON.stringify(manifest, null, 2)}\n`;
  const tmp = join(runDir, `.${MANIFEST_NAME}.tmp`);
  const fd = openSync(tmp, 'w', 0o600);
  try {
    writeFileSync(fd, body);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, join(runDir, MANIFEST_NAME));
  const dirFd = openSync(runDir, 'r');
  try {
    fsyncSync(dirFd);
  } finally {
    closeSync(dirFd);
  }
}
```

(Verify the `RunnerError` stage literal against `src/runner/errors.ts` — use an existing stage such as `'capture'`; if none fits, use the stage the terminal-capture path already uses.)

- [ ] **Step 4: Hook the runner terminal path**

In `src/runner/index.ts`, in `runScenario` immediately after the `writeFileSync(join(runDir, 'verdict.json'), ...)` block and before `return { runDir, verdict: identified };`:

```typescript
  if (a.campaign !== undefined) {
    writeAttemptManifest(runDir, a.campaign);
  }
```

Import `writeAttemptManifest` from `./manifest.ts`. The manifest throw propagates: a run whose evidence cannot be committed fails loud at the CLI boundary, and the host's publication check (Task 8) treats a missing manifest as `instrument_failure`.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `bun test test/runner-manifest.test.ts`
Expected: PASS.

- [ ] **Step 6: Run the full gate and commit**

Run: `bun run check && bun run quorum check && git diff --check`

```bash
git add src/runner/manifest.ts src/runner/index.ts test/runner-manifest.test.ts
git commit -m "feat(runner): commit the attempt manifest as the run's final act"
```

---

### Task 8: Host-side publication through the verified manifest

**Files:**
- Create: `src/campaign/attempt-publish.ts`
- Test: `test/campaign-attempt-publish.test.ts`

**Interfaces:**
- Consumes: `parseAttemptManifest` (`src/runner/manifest.ts`).
- Produces: `publishAttempt(args): { runId: string }`, `AttemptPublishError`. The dispatcher (Task 10) calls it between container exit and the terminal event.

- [ ] **Step 1: Write the failing tests**

Create `test/campaign-attempt-publish.test.ts`:

```typescript
import { expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AttemptPublishError, publishAttempt } from '../src/campaign/attempt-publish.ts';

const sha = (s: string): string => createHash('sha256').update(s).digest('hex');
const identity = {
  campaign_id: 'c'.repeat(64),
  comparison_id: 'c1',
  block_id: 'c1:s:b1',
  sample_id: 'c1:s:arm_a:r1',
  execution_attempt_id: 'c1:s:arm_a:r1:a1',
};

/** Build <attempt>/staging/<runId> with one verdict and a manifest listing it. */
function staged(runId: string, opts: { files?: { path: string; body: string }[] } = {}): { attemptDir: string; resultsRoot: string } {
  const attemptDir = mkdtempSync(join(tmpdir(), 'publish-'));
  const resultsRoot = mkdtempSync(join(tmpdir(), 'results-'));
  const runDir = join(attemptDir, 'staging', runId);
  mkdirSync(runDir, { recursive: true });
  const files = opts.files ?? [{ path: 'verdict.json', body: '{"final":"pass"}\n' }];
  for (const file of files) writeFileSync(join(runDir, file.path), file.body);
  const manifest = {
    schema_version: 1,
    campaign: identity,
    files: files.map((f) => ({ path: f.path, size: f.body.length, sha256: sha(f.body) })),
  };
  writeFileSync(join(runDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  return { attemptDir, resultsRoot };
}

test('publish verifies digests and performs exactly one rename into results', () => {
  const { attemptDir, resultsRoot } = staged('run-pub-1');
  const published = publishAttempt({ attemptDir, resultsRoot });
  expect(published.runId).toBe('run-pub-1');
  expect(existsSync(join(resultsRoot, 'run-pub-1', 'verdict.json'))).toBe(true);
  expect(existsSync(join(attemptDir, 'staging', 'run-pub-1'))).toBe(false);
  expect(readdirSync(resultsRoot)).toEqual(['run-pub-1']);
});

test('publish refuses a missing manifest typed', () => {
  const { attemptDir, resultsRoot } = staged('run-pub-2');
  // Remove the manifest after staging.
  rmSync(join(attemptDir, 'staging', 'run-pub-2', 'manifest.json'));
  expect(() => publishAttempt({ attemptDir, resultsRoot })).toThrow(AttemptPublishError);
  expect(existsSync(join(resultsRoot, 'run-pub-2'))).toBe(false);
});

test('publish refuses a digest mismatch typed', () => {
  const { attemptDir, resultsRoot } = staged('run-pub-3');
  // Tamper with the artifact after the manifest was written.
  writeFileSync(join(attemptDir, 'staging', 'run-pub-3', 'verdict.json'), 'tampered\n');
  expect(() => publishAttempt({ attemptDir, resultsRoot })).toThrow(/digest mismatch/);
  expect(existsSync(join(resultsRoot, 'run-pub-3'))).toBe(false);
});

test('publish refuses path traversal, absolute paths, and symlinks', () => {
  // Traversal entry in the manifest:
  const t = staged('run-pub-4');
  const manifestPath = join(t.attemptDir, 'staging', 'run-pub-4', 'manifest.json');
  const evil = { schema_version: 1, campaign: identity, files: [{ path: '../escape', size: 1, sha256: sha('x') }] };
  writeFileSync(manifestPath, JSON.stringify(evil));
  expect(() => publishAttempt(t)).toThrow(AttemptPublishError);
  // Symlinked artifact on disk:
  const s = staged('run-pub-5');
  const outside = join(s.attemptDir, 'outside.txt');
  writeFileSync(outside, 'outside\n');
  symlinkSync(outside, join(s.attemptDir, 'staging', 'run-pub-5', 'link.txt'));
  const symManifest = {
    schema_version: 1,
    campaign: identity,
    files: [{ path: 'link.txt', size: 8, sha256: sha('outside\n') }],
  };
  writeFileSync(join(s.attemptDir, 'staging', 'run-pub-5', 'manifest.json'), JSON.stringify(symManifest));
  expect(() => publishAttempt(s)).toThrow(/non-regular|missing/);
});

test('publish refuses two run directories under staging', () => {
  const { attemptDir, resultsRoot } = staged('run-pub-6');
  mkdirSync(join(attemptDir, 'staging', 'run-pub-6b'));
  expect(() => publishAttempt({ attemptDir, resultsRoot })).toThrow(/exactly one/);
});

test('publish refuses an already-existing results/<run-id>', () => {
  const { attemptDir, resultsRoot } = staged('run-pub-7');
  mkdirSync(join(resultsRoot, 'run-pub-7'));
  expect(() => publishAttempt({ attemptDir, resultsRoot })).toThrow(AttemptPublishError);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test test/campaign-attempt-publish.test.ts`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement attempt-publish.ts**

Create `src/campaign/attempt-publish.ts`:

```typescript
import {
  closeSync,
  fsyncSync,
  lstatSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { parseAttemptManifest } from '../runner/manifest.ts';

export class AttemptPublishError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AttemptPublishError';
  }
}

export interface PublishAttemptArgs {
  readonly attemptDir: string;
  readonly resultsRoot: string;
}

/** Minimal host-side publication (child 1): exactly one run dir under
 *  staging/, manifest present, every digest/size verified, every listed
 *  path relative/contained/regular, then ONE atomic rename into the
 *  results root and an fsync of the results directory. Rename after
 *  journal, or journal after rename, each leaves a distinct crash cut —
 *  child 2 defines the reconciliation; child 1 records the order so the
 *  observed cuts are real. */
export function publishAttempt(args: PublishAttemptArgs): { runId: string } {
  const staging = join(args.attemptDir, 'staging');
  let entries: string[];
  try {
    entries = readdirSync(staging);
  } catch {
    throw new AttemptPublishError(`attempt staging missing: ${staging}`);
  }
  if (entries.length !== 1) {
    throw new AttemptPublishError(
      `attempt staging must hold exactly one run directory, found [${entries.join(', ')}]`,
    );
  }
  const runId = entries[0]!;
  const runDir = join(staging, runId);
  if (!lstatSync(runDir).isDirectory()) {
    throw new AttemptPublishError(`staging entry is not a directory: ${runId}`);
  }
  const manifestPath = join(runDir, 'manifest.json');
  let raw: string;
  try {
    raw = readFileSync(manifestPath, 'utf8');
  } catch {
    throw new AttemptPublishError(`manifest missing for run ${runId}`);
  }
  const manifest = (() => {
    try {
      return parseAttemptManifest(raw);
    } catch (error) {
      throw new AttemptPublishError(
        `manifest invalid for run ${runId}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  })();
  for (const file of manifest.files) {
    const full = join(runDir, file.path);
    const stats = lstatSync(full, { throwIfNoEntry: false });
    if (stats === undefined || stats.isSymbolicLink() || !stats.isFile()) {
      throw new AttemptPublishError(
        `manifest lists a non-regular or missing artifact: ${file.path}`,
      );
    }
    const bytes = readFileSync(full);
    if (bytes.length !== file.size) {
      throw new AttemptPublishError(
        `size mismatch for ${file.path}: manifest ${file.size}, disk ${bytes.length}`,
      );
    }
    const digest = createHash('sha256').update(bytes).digest('hex');
    if (digest !== file.sha256) {
      throw new AttemptPublishError(
        `digest mismatch for ${file.path}: manifest ${file.sha256}, disk ${digest}`,
      );
    }
  }
  const destination = join(args.resultsRoot, runId);
  try {
    renameSync(runDir, destination);
  } catch (error) {
    throw new AttemptPublishError(
      `publication rename failed for run ${runId}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const dirFd = openSync(args.resultsRoot, 'r');
  try {
    fsyncSync(dirFd);
  } finally {
    closeSync(dirFd);
  }
  return { runId };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun test test/campaign-attempt-publish.test.ts`
Expected: PASS.

- [ ] **Step 5: Run the full gate and commit**

Run: `bun run check && bun run quorum check && git diff --check`

```bash
git add src/campaign/attempt-publish.ts test/campaign-attempt-publish.test.ts
git commit -m "feat(campaign): publish attempt results through the verified manifest"
```

---

### Task 9: SIGTERM joins the one idempotent stop path

**Files:**
- Modify: `src/cli/run-command.ts`
- Test: `test/run-command-sigterm.test.ts`

**Interfaces:**
- Consumes: `executeRunCommand`'s existing SIGINT stop path (`onSigint`, `stopExitCode`, `currentGauntletChild`).
- Produces: identical handling for SIGTERM, so `docker stop` (SIGTERM → init → Quorum) drives the graceful stopped-evidence path (parent spec "Cancellation and interruption"; child 1 integration assertion).

- [ ] **Step 1: Write the failing test**

Create `test/run-command-sigterm.test.ts` exercising the exported handler installer (Step 3):

```typescript
import { expect, test } from 'bun:test';
import { installRunStopHandlers, RunStopState } from '../src/cli/run-command.ts';

test('SIGTERM and SIGINT share one idempotent stop path', () => {
  const state: RunStopState = { stopExitCode: null };
  let killed: NodeJS.Signals[] = [];
  const uninstall = installRunStopHandlers(state, (signal) => {
    killed.push(signal);
  });
  process.emit('SIGTERM', 'SIGTERM');
  process.emit('SIGINT', 'SIGINT');
  expect(state.stopExitCode).toBe(2);
  expect(killed).toEqual(['SIGINT', 'SIGINT']); // gauntlet child always stopped via SIGINT
  process.emit('SIGTERM', 'SIGTERM'); // idempotent: still 2, no duplicate kill recorded
  expect(state.stopExitCode).toBe(2);
  uninstall();
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test test/run-command-sigterm.test.ts`
Expected: FAIL — `installRunStopHandlers` not exported.

- [ ] **Step 3: Implement the shared handler**

In `src/cli/run-command.ts`, export the state/handler pair and rewire `executeRunCommand` to use it:

```typescript
export interface RunStopState {
  stopExitCode: number | null;
}

/** The one idempotent stop path: an interactive SIGINT and the SIGTERM a
 *  `docker stop` delivers through the attempt container's init enter the
 *  same handler — kill the gauntlet child with the established stop signal,
 *  record the stop, let the runner's phase boundaries settle it. */
export function installRunStopHandlers(
  state: RunStopState,
  killGauntletChild: (signal: NodeJS.Signals) => void,
): () => void {
  const onStop = (): void => {
    if (state.stopExitCode !== null) return;
    killGauntletChild('SIGINT');
    state.stopExitCode = 2;
  };
  process.once('SIGINT', onStop);
  process.once('SIGTERM', onStop);
  return () => {
    process.off('SIGINT', onStop);
    process.off('SIGTERM', onStop);
  };
}
```

In `executeRunCommand`, replace the local `onSigint` definition, `process.once('SIGINT', onSigint)`, and the `finally`'s `process.off('SIGINT', onSigint)` with:

```typescript
  const stopState: RunStopState = { stopExitCode: null };
  const uninstallStopHandlers = installRunStopHandlers(stopState, (signal) => {
    currentGauntletChild()?.kill(signal);
  });
```

and update every `stopExitCode` read/write in the function body to `stopState.stopExitCode`; call `uninstallStopHandlers()` first in the `finally` block.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun test test/run-command-sigterm.test.ts`
Expected: PASS. Also run the existing runner stop coverage: `bun test test/ | grep -i stop` equivalents — simply run `bun test test/runner-stopped.test.ts test/run-command*.test.ts` if those files exist (check with `rg --files test | rg 'stop|sigint'`).

- [ ] **Step 5: Run the full gate and commit**

Run: `bun run check && bun run quorum check && git diff --check`

```bash
git add src/cli/run-command.ts test/run-command-sigterm.test.ts
git commit -m "feat(cli): route SIGTERM through the run stop path"
```

---

### Task 10: Dispatcher container routing (staging out-root, container journaling, publish-then-terminal, verified death by kind)

**Files:**
- Modify: `src/campaign/dispatcher.ts`
- Test: `test/campaign-dispatcher-container.test.ts`

**Interfaces:**
- Consumes: `ContainerAttemptSpawner` (Tasks 2–4), `prepareAttemptStage`/`removeAttemptStage` (Task 6), `publishAttempt` (Task 8), `buildAttemptMounts` (Task 2), the Task 1 handle union.
- Produces: the container execution path inside `runCampaignDispatch`; `isContainerSpawner` type guard; the process path byte-for-byte unchanged.

- [ ] **Step 1: Write the failing tests**

Create `test/campaign-dispatcher-container.test.ts`. It reuses the `runCampaignDispatch` harness shape from `test/campaign-dispatcher.test.ts` (journal temp dir, registered campaign fixture, `FakeClock`, fake signaler/identity seams). The container spawner fake records every call:

```typescript
import { expect, test } from 'bun:test';
import { FakeClock } from '../src/scheduler/clock.ts';
import type { CampaignChildSpec, SpawnedCampaignChild, ChildExitInfo } from '../src/campaign/spawn.ts';

/** The dispatcher-facing fake: everything the container path touches. */
class RecordingContainerSpawner {
  readonly kind = 'container' as const;
  readonly prepared: unknown[] = [];
  readonly specs: CampaignChildSpec[] = [];
  readonly stopped: { containerId: string; graceSeconds: number }[] = [];
  readonly removedStages: string[] = [];
  publishBehavior: 'ok' | 'missing-manifest' = 'ok';
  private readonly children: ((info: ChildExitInfo) => void)[][] = [];

  prepareAttempt(args: unknown) {
    this.prepared.push(args);
    // Return the PreparedAttemptStage shape; attemptDir under the fixture
    // campaign dir, one subdir per attempt id.
    return { /* attemptId, attemptDir, stageDir, subjectEnvFile, graderEnvFile,
                homeDir, stdoutLog, stderrLog, stagingDir, passwdFile, groupFile */ } as never;
  }

  spawn(spec: CampaignChildSpec): SpawnedCampaignChild {
    this.specs.push(spec);
    const exitCbs: ((info: ChildExitInfo) => void)[] = [];
    this.children.push(exitCbs);
    return {
      handle: { kind: 'container', containerId: 'a'.repeat(64), imageDigest: `sha256:${'b'.repeat(64)}` },
      stdoutLines: [],
      stderrLines: [],
      onStdoutLine: () => {},
      onStderrLine: () => {},
      onExit: (cb) => exitCbs.push(cb),
    };
  }

  emitAllocated(index: number, runId: string): void {
    // Deliver the run_allocated line through the child's stdout subscription
    // the dispatcher registered (capture the onStdoutLine cb in spawn to do
    // this — extend the fake accordingly).
  }

  settleExit(index: number, info: ChildExitInfo): void {
    for (const cb of this.children[index] ?? []) cb(info);
  }

  async stopContainer(containerId: string, graceSeconds: number): Promise<'dead' | 'alive'> {
    this.stopped.push({ containerId, graceSeconds });
    return 'dead';
  }
}

test('container path: staging out-root, container payload journaled, no pgid', async () => {
  // Harness: runCampaignDispatch with the fixture campaign, FakeClock, and
  // spawner = new RecordingContainerSpawner() passed through the dispatcher's
  // `spawner` parameter. Drive one admitted sample: the fake delivers
  // `run_allocated: <run-id>` on its stdout seam, then the test reads the
  // journal.
  //
  // Assertions:
  //   const events = readJournalEvents(journalPath);
  //   const allocated = events.find((e) => e.type === 'run_allocated')!;
  //   expect(allocated.payload).toMatchObject({
  //     attempt_id: <fixture attempt>, run_id: <emitted>,
  //     container_id: 'a'.repeat(64),
  //     image_digest: `sha256:${'b'.repeat(64)}`,
  //   });
  //   expect('pgid' in allocated.payload).toBe(false);
  //   const spec = spawner.specs[0]!;
  //   expect(spec.args[spec.args.indexOf('--out-root') + 1])
  //     .toBe(`${attemptDir}/staging`);
});

test('container path: CampaignChildSpec.env carries no credential value', async () => {
  // Record the spec the spawner received in the test above; assert
  // Object.keys(spec.env) contains only PATH and no value from the fixture
  // bundle appears anywhere in spec.env or spec.args.
});

test('container path: exit publishes through the manifest before run_completed', async () => {
  // Before settling exit, write staging/<run-id>/{verdict.json,manifest.json}
  // (use the publisher test's `staged()` builder against the attempt dir).
  // Settle exit { code: 0, signal: null }. Assert the journal's terminal
  // event is run_completed with that run id, results/<run-id>/verdict.json
  // exists, and staging/<run-id> is gone — proof publication preceded the
  // terminal read.
});

test('container path: missing manifest at exit journals instrument_failure and retains logs', async () => {
  // Settle exit with an EMPTY staging dir. Assert instrument_failure for the
  // attempt, the attempt directory (logs included) intact, and no
  // results/<run-id>.
});

test('container path: verified death routes docker stop, never a tmux probe', async () => {
  // Trigger the dispatcher's kill path (halt/teardown as the existing
  // kill tests in test/campaign-dispatcher.test.ts do) with one live
  // container child. Assert spawner.stopped contains the exact container id
  // and the fake subject-host probe recorded ZERO calls.
});

test('container path: stage removed only after the terminal event journals', async () => {
  // Wrap the journal append seam and removeAttemptStage to record call
  // order; assert every terminal append precedes the stage removal for the
  // same attempt.
});
```

Each commented body states the exact assertions; implement them with the fixture builders copied from `test/campaign-dispatcher.test.ts` (its `FakeSpawner` shows how the harness threads the spawner, and its journal reader shows how events are asserted).

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test test/campaign-dispatcher-container.test.ts`
Expected: FAIL — routing missing.

- [ ] **Step 3: Implement dispatcher routing**

In `src/campaign/dispatcher.ts`:

1. Type guard + injection. Import `ContainerAttemptSpawner`, `prepareAttemptStage`, `removeAttemptStage`, `buildAttemptMounts`, `publishAttempt`, `AttemptPublishError`. Next to `const spawner = args.spawner ?? new DetachedChildSpawner();`:

```typescript
    const isContainerSpawner = (
      s: ChildSpawner,
    ): s is ContainerAttemptSpawner => s.kind === 'container';
    const containerSpawner = isContainerSpawner(spawner) ? spawner : null;
```

2. `spawnSample`: after the two `resolveKeyForSpawnWithWait` calls and `sample.grants` assignment, branch:

```typescript
        if (containerSpawner !== null) {
          const prepared = containerSpawner.prepareAttempt({
            attemptId: sample.attemptId,
            agent: surfaceOfArm(sample.arm).agent,
            credentialName: subjectName,
            evalsRoot,
            superpowersTree:
              superpowersSha !== null && superpowersSha !== undefined
                ? join(args.campaignDir, `superpowers-${superpowersSha}`)
                : null,
          });
          const argv = buildCampaignChildArgv({
            /* identical arguments to the process path, except: */
            outRoot: prepared.stagingDir,
            /* ...all others unchanged... */
          });
          const spec: CampaignChildSpec = {
            command: 'bun',
            args: argv,
            cwd: evalsRoot,
            // Container path: names only. The VALUES travel in the two 0400
            // stage files; the parent env is never composed into the spec.
            env: { PATH: getEnv('PATH') },
            attempt: {
              attemptId: sample.attemptId,
              attemptDir: prepared.attemptDir,
              stdoutLog: prepared.stdoutLog,
              stderrLog: prepared.stderrLog,
              homeDir: prepared.homeDir,
              entrypoint: join(evalsRoot, 'container', 'attempt-entrypoint.sh'),
              mounts: buildAttemptMounts({
                evalsRoot,
                gauntletRoot: join(args.campaignDir, 'gauntlet'),
                binRoot: join(args.campaignDir, 'bin'),
                superpowersTree: /* same expression as above */,
                attemptDir: prepared.attemptDir,
                subjectEnvFile: prepared.subjectEnvFile,
                graderEnvFile: prepared.graderEnvFile,
                passwdFile: prepared.passwdFile,
                groupFile: prepared.groupFile,
              }),
            },
          };
          const child = spawner.spawn(spec);
          /* in-flight increments identical to the process path */
          superviseSample(sample, child, live);
          spawnFailuresByPool.set(sample.subjectPool, 0);
          return 'spawned';
        }
```

Keep the existing process-path code as the `else` body unchanged. (`prepareAttempt` is the spawner method wrapping `prepareAttemptStage` with its constructor's `campaignDir`/`bundleDir`/`uid`/`gid` — add that method to `ContainerAttemptSpawner` in this step, delegating to Task 6's function and storing `bundleDir`, `uid`, `gid` on the constructor args; extend the constructor args type accordingly.)

3. `recordAllocation`: already arm-aware from Task 1 — replace the Task 1 `pgidOf`-based liveness probe with: process arm keeps `signalGroup(...) === 'esrch'` check; container arm journals directly (no pre-probe).

4. Allocation-wait timeout kill and every teardown/kill sweep that currently signals a live child's group: route through one helper:

```typescript
    const stopChildVerified = async (
      child: SpawnedCampaignChild,
      graceSeconds: number,
    ): Promise<'dead' | 'alive' | 'unknown'> => {
      if (child.handle.kind === 'container') {
        if (containerSpawner === null) return 'unknown';
        return (await containerSpawner.stopContainer(child.handle.containerId, graceSeconds)) === 'dead'
          ? 'dead'
          : 'alive';
      }
      const outcome = await killGroupVerified({ pgid: child.handle.pgid, /* existing args unchanged */ });
      return outcome === 'dead' || outcome === 'stale' ? 'dead' : outcome === 'alive' ? 'alive' : 'unknown';
    };
```

Replace the `pgidOf` throw sites (Task 1) with this helper; on the container path `killSubjectHostVerified` is NEVER called.

5. `superviseSample`'s `onExit` handler: on the container path, publish before the evidence sweep:

```typescript
          if (child.handle.kind === 'container' && containerSpawner !== null) {
            try {
              const published = publishAttempt({
                attemptDir: /* the sample's prepared attempt dir — record it on LiveSampleState at spawn */,
                resultsRoot,
              });
              if (sample.runId === undefined) {
                // Unallocated child that still committed a manifest: bind it.
                sample.runId = published.runId;
              } else if (sample.runId !== published.runId) {
                throw new AttemptPublishError(
                  `published run ${published.runId} disagrees with the journaled allocation ${sample.runId}`,
                );
              }
            } catch (error) {
              stream.write(
                `publication failed for ${sample.attemptId}: ${error instanceof Error ? error.message : String(error)} — classifying instrument_failure with logs retained\n`,
              );
            }
          }
```

Place this BEFORE `const runDir = ...` so `runDirOf(sample.runId)` reads the published results path. Publication failure leaves `runDir` null → the existing classifier produces `instrument_failure` (no fabricated verdict).

6. Stage removal: after the terminal event append for the sample (both `run_completed` and `instrument_failure` arms), on the container path call `removeAttemptStage(attemptDir)` — the container is already verified stopped by exit publication order (the spawner only published exit after `docker wait`). Wrap in try/catch with a loud stream write on failure; a removal failure never blocks the terminal.

7. Record `attemptDir` on `LiveSampleState` (add `attemptDir?: string`, set in the container branch of `spawnSample`).

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun test test/campaign-dispatcher-container.test.ts test/campaign-dispatcher.test.ts`
Expected: PASS — container tests green, process path unchanged.

- [ ] **Step 5: Run the full gate and commit**

Run: `bun run check && bun run quorum check && git diff --check`

```bash
git add src/campaign/dispatcher.ts src/campaign/container-spawner.ts test/campaign-dispatcher-container.test.ts
git commit -m "feat(campaign): route campaign attempts through containers"
```

---

### Task 11: Recovery container routing

**Files:**
- Modify: `src/campaign/recovery.ts`
- Test: `test/campaign-recovery-container.test.ts`

**Interfaces:**
- Consumes: the container `run_allocated` arm (Task 1), `ContainerStopper` (Task 4).
- Produces: `killJournaledPgids` stops journaled container handles through the injected stopper; report fields `containersStopped: string[]`, `containersSurvived: string[]`.

- [ ] **Step 1: Write the failing tests**

Create `test/campaign-recovery-container.test.ts`:

```typescript
test('recovery stops a journaled container handle through the injected stopper', async () => {
  // events: run_allocated container arm, no terminal; fake stopper returns
  // 'dead'; report.containersStopped contains the id; no signaler or
  // subject-host probe invoked.
});

test('recovery reports a surviving container loudly and never counts it stopped', async () => {});

test('recovery without a stopper refuses to verify a container handle (loud)', async () => {
  // the Task 1 loud skip: assert the stream message and that the attempt is
  // not counted killed.
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test test/campaign-recovery-container.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement recovery routing**

In `src/campaign/recovery.ts` `killJournaledPgids`: add optional args `containerStop?: ContainerStopper` and report fields `containersStopped: string[]`, `containersSurvived: string[]` (extend `KillJournaledPgidsReport`). Replace the Task 1 loud-skip branch:

```typescript
    if ('container_id' in event.payload) {
      if (args.containerStop === undefined) {
        stream.write(
          `run_allocated ${event.payload.attempt_id} journaled a container handle (${event.payload.container_id}) — no container stopper injected; recorded, not verified\n`,
        );
        continue;
      }
      const outcome = await args.containerStop.stop(event.payload.container_id, graceSeconds);
      if (outcome === 'dead') containersStopped.push(event.payload.container_id);
      else {
        containersSurvived.push(event.payload.container_id);
        stream.write(
          `orphan container ${event.payload.container_id} (attempt ${attemptId}) survived stop+kill — operator action: docker rm -f it before resuming; it is still spending\n`,
        );
      }
      continue; // a stopped container is verified death for the whole attempt — no tmux probe
    }
```

Thread `containerStop` through `resumeCampaign`/`cancelCampaign` arg objects where they forward `subjectHost` (mirror the existing `...(args.subjectHost !== undefined ? { subjectHost: args.subjectHost } : {})` pattern with `containerStop`).

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun test test/campaign-recovery-container.test.ts test/campaign-recovery.test.ts`
Expected: PASS.

- [ ] **Step 5: Run the full gate and commit**

Run: `bun run check && bun run quorum check && git diff --check`

```bash
git add src/campaign/recovery.ts test/campaign-recovery-container.test.ts
git commit -m "feat(campaign): verify container death on the recovery path"
```

---

### Task 12: Expose the run entry point with an injected spawner

**Files:**
- Modify: `src/cli/campaign.ts`
- Test: `test/campaign-cli-verbs.test.ts` (append) or `test/campaign-run-spawner-injection.test.ts`

**Interfaces:**
- Consumes: `resumeCampaign`'s existing `spawner?: ChildSpawner` argument (`src/campaign/recovery.ts:1832`).
- Produces: `campaignRun(rawCampaignDir, opts?)` callable by the appliance worker (Task 13). No new CLI flag — the public `quorum campaign run` command still calls `campaignRun(dir)` with no opts.

- [ ] **Step 1: Write the failing test**

`test/campaign-resume.test.ts` already drives full portable campaigns through `resumeCampaign({ ..., spawner: new FakeSpawner() })` (its `FakeSpawner` records `spawned`, its fixture builder registers a real campaign dir). Add the injection test in `test/campaign-cli-verbs.test.ts` reusing those exact pieces (import or duplicate that file's fixture builder the way the existing verb tests already share fixtures):

```typescript
test('campaignRun forwards an injected spawner to the controller', async () => {
  // Fixture: the same registered one-block campaign fixture
  // test/campaign-resume.test.ts uses for its fake-spawner runs.
  const fixture = await registeredCampaignFixture(); // builder from campaign-resume.test.ts
  const spawner = new FakeSpawner(); // needs the Task 1 `readonly kind = 'process' as const;`
  const exit = await campaignRun(fixture.campaignDir, { spawner });
  expect(exit).toBe(0);
  expect(spawner.spawned.length).toBeGreaterThan(0); // the injected spawner ran the attempts
});

test('campaignRun without options keeps the process spawner default', async () => {
  // The raw verb path is unchanged: call campaignRun(dir) against a fixture
  // that completes with zero attempts to spawn (e.g. already-complete), and
  // assert exit 0 with no behavioral difference — this guards the "no new
  // flag, no behavior change for `quorum campaign run`" contract.
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test test/campaign-cli-verbs.test.ts`
Expected: FAIL — signature mismatch.

- [ ] **Step 3: Implement the injection**

In `src/cli/campaign.ts`:

```typescript
export interface CampaignRunOptions {
  /** The appliance worker injects the container spawner; the raw verb keeps
   *  the process spawner default (local development and tests). */
  readonly spawner?: ChildSpawner;
}

export async function campaignRun(
  rawCampaignDir: string,
  opts: CampaignRunOptions = {},
): Promise<number> {
```

…and in the `resumeCampaign` call near the end:

```typescript
    const outcome = await resumeCampaign({
      campaignDir,
      credentials,
      evalsCheckout: checkouts.evalsCheckout,
      gauntletCheckout: checkouts.gauntletCheckout,
      superpowersCheckout: checkouts.superpowersCheckout,
      ...(opts.spawner !== undefined ? { spawner: opts.spawner } : {}),
    });
```

Import `type ChildSpawner` from `../campaign/spawn.ts`. Update the CLI command action call site only if the signature change requires it (it does not — `opts` defaults).

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun test test/campaign-cli-verbs.test.ts`
Expected: PASS.

- [ ] **Step 5: Run the full gate and commit**

Run: `bun run check && bun run quorum check && git diff --check`

```bash
git add src/cli/campaign.ts test/campaign-cli-verbs.test.ts
git commit -m "feat(campaign): let the appliance worker inject the attempt spawner"
```

---

### Task 13: Appliance contracts — `campaign-run` job kind, campaign block, lock config

**Files:**
- Modify: `src/appliance/types.ts`
- Modify: `src/appliance/jobs.ts`
- Test: `test/appliance-jobs.test.ts` (append; find the existing job-record tests first with `rg -l "createJob" test/`)

**Interfaces:**
- Produces: `ApplianceCommandKindSchema` `'campaign-run'`, `JobCampaignSchema` block on `JobRecord`, `live_spend_lock` config field, the `campaign-run` `CreateJobRequest` variant.

- [ ] **Step 1: Write the failing tests**

Append to the existing appliance job-record test file:

```typescript
test('campaign-run job record persists the campaign block and empty credential authority', () => {
  // createJob(loaded, { kind: 'campaign-run', superpowersRef: evalsSha,
  // argv: ['evals-appliance', 'campaign', 'run', id], requester,
  // credentialSelection: null, credentialScope: EMPTY_CREDENTIAL_SCOPE,
  // credentialScopeSourceEvalsSha: null, campaign: { campaign_id,
  // campaign_dir, evals_sha, helper_sha, image_ref, image_digest } });
  // re-read through readJob: campaign block round-trips, status
  // 'preflighting', credential fields null/empty.
});

test('job schema rejects a campaign block with malformed shas', () => {
  // evals_sha 'xyz' refuses; image_digest without sha256: refuses.
});

test('config schema accepts an optional live_spend_lock path', () => {
  // ApplianceConfigSchema.parse with live_spend_lock '/var/lib/quorum/live-spend.lock.d'
  // passes; absent still parses.
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test test/appliance-*.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement the contracts**

In `src/appliance/types.ts`:

```typescript
export const ApplianceCommandKindSchema = z.enum([
  'prepare',
  'run',
  'run-all',
  'import',
  'prune',
  'campaign-run',
]);

export const JobCampaignSchema = z.object({
  campaign_id: z.string().min(1),
  campaign_dir: z.string().min(1),
  evals_sha: z.string().regex(/^[0-9a-f]{40}$/),
  helper_sha: z.string().regex(/^[0-9a-f]{40}$/),
  image_ref: z.string().min(1),
  image_digest: z.string().regex(/^sha256:[0-9a-f]{64}$/),
});
export type JobCampaign = z.infer<typeof JobCampaignSchema>;
```

Add to `JobRecordSchema` (additive, mirroring the `credential_selection` default pattern):

```typescript
  campaign: JobCampaignSchema.nullable().default(null),
```

Add to `ApplianceConfigSchema`:

```typescript
  live_spend_lock: z.string().optional(),
```

In `src/appliance/jobs.ts`, extend the `CreateJobRequest` union:

```typescript
  | (CreateJobRequestBase & {
      readonly kind: 'campaign-run';
      readonly runId?: never;
      // A campaign-run job carries NO per-cell credential authority: every
      // attempt stages its own exact projection at admission (child 1
      // attempt-projection). The empty scope is the asserted zero-material
      // statement, exactly like prepare's.
      readonly credentialSelection: null;
      readonly credentialScope: EmptyCredentialScope;
      readonly credentialScopeSourceEvalsSha: null;
      readonly campaign: JobCampaign;
    })
```

In `createJob`, persist `campaign: request.kind === 'campaign-run' ? request.campaign : null` on the initial record (import `type JobCampaign` from `./types.ts`). Decision recorded: the required `request.superpowers_ref` field carries the campaign's frozen evals SHA for `campaign-run` jobs (informational; the `campaign` block is the authority — mirrors the `import` kind's sentinel precedent).

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun test test/appliance-*.test.ts`
Expected: PASS (existing readers keep parsing older records via the null default).

- [ ] **Step 5: Run the full gate and commit**

Run: `bun run check && bun run quorum check && git diff --check`

```bash
git add src/appliance/types.ts src/appliance/jobs.ts test/appliance-jobs.test.ts
git commit -m "feat(appliance): add the campaign-run job contract"
```

---

### Task 14: The `campaign run` verb and worker body

**Files:**
- Create: `src/appliance/campaign-run.ts`
- Modify: `src/appliance/process.ts` (detached dispatch + cancel branch)
- Modify: `src/appliance/cli.ts` (verb registration + action)
- Test: `test/appliance-campaign-run.test.ts`

**Interfaces:**
- Consumes: Task 13 contracts, `ContainerAttemptSpawner`, `campaignRun` with injection (Task 12), `acquireLock` (`src/appliance/locks.ts`), `createJob`/`readJob`/`updateJob` (`src/appliance/jobs.ts`), `currentCheckoutSha` (`src/appliance/git.ts`).
- Produces: `runCampaignWorker`, the `campaignRun` appliance action, `evals-appliance campaign run <campaign-id> [--json]`.

- [ ] **Step 1: Write the failing tests**

Create `test/appliance-campaign-run.test.ts`. Copy the temp-appliance-root setup from `test/appliance-process.test.ts` (write `appliance.json`, create `state/{jobs,locks,provenance}`, a blessed bundle dir with `metadata.json`, and a fake evals checkout) — that file's `FakeRunner` and fixture builders are the harness this file reuses. Two additions: a campaign fixture dir `<evals>/campaigns/<id>/campaign.json` containing `{ "refs": { "evals": "<40-hex>" }, "campaign_id": "<id>" }`, and a `FakeRunner` arm answering `docker image inspect superpowers-evals:local --format {{.Id}}` with `sha256:<64-hex>`.

```typescript
test('verb refuses a campaign id escaping the basename grammar before any job record', async () => {
  const fx = campaignFixture(); // harness above
  await expect(
    fx.actions.campaignRun({ campaignId: '../escape', json: false }),
  ).rejects.toThrow(/closed basename/);
  expect(fx.jobIds()).toEqual([]); // nothing recorded
});

test('verb refuses a missing campaign.json before any job record', async () => {
  const fx = campaignFixture();
  await expect(
    fx.actions.campaignRun({ campaignId: 'does-not-exist', json: false }),
  ).rejects.toThrow(/campaign not found/);
  expect(fx.jobIds()).toEqual([]);
});

test('verb refuses an absent worker image before any job record', async () => {
  const fx = campaignFixture({ imagePresent: false });
  await expect(
    fx.actions.campaignRun({ campaignId: fx.campaignId, json: false }),
  ).rejects.toThrow(/worker image/);
  expect(fx.jobIds()).toEqual([]);
});

test('verb writes a complete campaign-run record and spawns the detached worker', async () => {
  const fx = campaignFixture();
  const result = (await fx.actions.campaignRun({ campaignId: fx.campaignId, json: false })) as JobRecord;
  expect(result.kind).toBe('campaign-run');
  expect(result.campaign).toEqual({
    campaign_id: fx.campaignId,
    campaign_dir: join(fx.evalsPath, 'campaigns', fx.campaignId),
    evals_sha: fx.evalsSha,
    helper_sha: expect.stringMatching(/^[0-9a-f]{40}$/),
    image_ref: 'superpowers-evals:local',
    image_digest: fx.imageDigest,
  });
  expect(result.command.argv).toEqual(['evals-appliance', 'campaign', 'run', fx.campaignId]);
  expect(result.credential_selection).toBeNull();
  expect(result.credential_scope?.kind).toBe('empty');
  expect(fx.spawned).toEqual([result.job_id]);
});

test('worker acquires run.lock only, never sync.lock, and releases it in finally', async () => {
  const fx = campaignFixture();
  const job = (await fx.actions.campaignRun({ campaignId: fx.campaignId, json: false })) as JobRecord;
  const calls: string[] = [];
  const exit = await runCampaignWorker(fx.loaded, job.job_id, fx.runner, {
    runCampaign: async () => {
      calls.push(...fx.lockNamesHeld()); // reads the locks dir while held
      return 0;
    },
  });
  expect(exit).toBeUndefined();
  expect(calls).toEqual(['run.lock']); // sync.lock never acquired
  expect(fx.lockNamesHeld()).toEqual([]); // released in finally
  expect(fx.readJob(job.job_id).status).toBe('done');
});

test('worker refuses an image digest that moved between submission and lock', async () => {
  const fx = campaignFixture({ imageDigestAfter: `sha256:${'e'.repeat(64)}` });
  const job = (await fx.actions.campaignRun({ campaignId: fx.campaignId, json: false })) as JobRecord;
  await expect(
    runCampaignWorker(fx.loaded, job.job_id, fx.runner, { runCampaign: async () => 0 }),
  ).rejects.toThrow(/image moved/);
  expect(fx.readJob(job.job_id).status).toBe('failed');
});

test('worker exports QUORUM_LIVE_SPEND_LOCK from config for the in-process controller', async () => {
  const fx = campaignFixture({ liveSpendLock: '/var/lib/quorum/live-spend.lock.d' });
  const job = (await fx.actions.campaignRun({ campaignId: fx.campaignId, json: false })) as JobRecord;
  let seen: string | undefined;
  await runCampaignWorker(fx.loaded, job.job_id, fx.runner, {
    runCampaign: async () => {
      seen = process.env.QUORUM_LIVE_SPEND_LOCK;
      return 0;
    },
  });
  expect(seen).toBe('/var/lib/quorum/live-spend.lock.d');
});

test('cancel on a campaign-run job settles on controller death without a terminal artifact', async () => {
  // Mirror the existing cancel tests in test/appliance-process.test.ts:
  // create the campaign-run job, mark it running with a recorded host pgid,
  // script the FakeRunner so the process group answers dead after the
  // SIGINT, then cancelJob(...); expect status 'cancelled', a summary naming
  // the campaign journal as the outcome authority, and NO wait for a
  // run/batch terminal artifact.
  const fx = campaignFixture();
  const job = (await fx.actions.campaignRun({ campaignId: fx.campaignId, json: false })) as JobRecord;
  fx.markRunning(job.job_id, { hostPid: 4242, hostPgid: 4242 });
  fx.scriptProcessGroupDeath(4242);
  const cancelled = await cancelJob(fx.loaded, job.job_id, fx.runner, { graceMs: 50, pollIntervalMs: 5 });
  expect(cancelled.status).toBe('cancelled');
  expect(cancelled.result.summary).toMatch(/campaign journal/);
});
```

The `campaignFixture()` helper returns `{ loaded, runner, actions, campaignId, evalsSha, imageDigest, evalsPath, jobIds(), spawned, lockNamesHeld(), readJob, markRunning, scriptProcessGroupDeath }` built from the existing appliance test utilities (`createApplianceActions` with faked `ApplianceActionDeps`, exactly as `test/appliance-cli.test.ts` does). `imagePresent: false` removes the docker-inspect arm; `imageDigestAfter` makes the second inspect answer a different digest; `liveSpendLock` sets the config field.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test test/appliance-campaign-run.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement the worker body**

Create `src/appliance/campaign-run.ts`:

```typescript
import { userInfo } from 'node:os';
import type { CommandRunner } from '../agents/command-runner.ts';
import { campaignRun } from '../cli/campaign.ts';
import { ContainerAttemptSpawner, realDockerWait } from '../campaign/container-spawner.ts';
import { RealClock } from '../scheduler/clock.ts';
import { ApplianceError } from './errors.ts';
import { readJob, updateJob } from './jobs.ts';
import { acquireLock, type LockHandle } from './locks.ts';
import type { LoadedApplianceConfig } from './types.ts';

export const CAMPAIGN_IMAGE_REF = 'superpowers-evals:local';

export function imageDigestOf(
  runner: CommandRunner,
  imageRef: string,
): string {
  const result = runner.run('docker', ['image', 'inspect', imageRef, '--format', '{{.Id}}']);
  if (result.status !== 0 || result.stdout.trim() === '') {
    throw new ApplianceError(
      'config_invalid',
      'image',
      `worker image ${imageRef} is not present on this appliance (run scripts/evals-container build)`,
    );
  }
  return result.stdout.trim(); // sha256:<64hex>
}

export interface RunCampaignWorkerDeps {
  /** The in-process controller call; tests stub it to observe lock and
   *  env state without running the real campaign engine. Production is
   *  `campaignRun` from src/cli/campaign.ts. */
  readonly runCampaign?: (
    campaignDir: string,
    opts: { readonly spawner: ContainerAttemptSpawner },
  ) => Promise<number>;
}

export async function runCampaignWorker(
  loaded: LoadedApplianceConfig,
  jobId: string,
  runner?: CommandRunner,
  deps: RunCampaignWorkerDeps = {},
): Promise<void> {
  const commandRunner = runner ?? defaultCommandRunner; // import { defaultCommandRunner } from '../agents/command-runner.ts'
  const runCampaignFn = deps.runCampaign ?? campaignRun;
  let runLock: LockHandle | null = null;
  try {
    const job = readJob(loaded, jobId);
    if (job.kind !== 'campaign-run' || job.campaign === null) {
      throw new ApplianceError(
        'job_not_running',
        'campaign-worker',
        `${jobId} is not a campaign-run job`,
      );
    }
    // The digest is re-resolved and compared BEFORE run.lock: a swapped
    // image between submission and execution refuses typed.
    const currentDigest = imageDigestOf(commandRunner, CAMPAIGN_IMAGE_REF);
    if (currentDigest !== job.campaign.image_digest) {
      throw new ApplianceError(
        'config_invalid',
        'image',
        `worker image moved between submission and execution (${job.campaign.image_digest} -> ${currentDigest}) — rebuild or re-submit`,
      );
    }
    runLock = acquireLock({
      loaded,
      name: 'run.lock',
      jobId,
      command: job.kind,
      refs: null,
    });
    updateJob(loaded, jobId, (current) => ({
      ...current,
      status: 'running',
      started_at: current.started_at ?? new Date().toISOString(),
      error: null,
      process: {
        host_pid: process.pid,
        host_pgid: process.pid,
        container_pid: null,
        container_pgid: null,
      },
    }));
    if (loaded.config.live_spend_lock !== undefined) {
      process.env.QUORUM_LIVE_SPEND_LOCK = loaded.config.live_spend_lock;
    }
    const who = userInfo();
    const spawner = new ContainerAttemptSpawner({
      runner: commandRunner,
      clock: new RealClock(),
      stream: {
        write: (s) => {
          appendLog(readJob(loaded, jobId).artifacts.stdout_log, s);
        },
      },
      campaignId: job.campaign.campaign_id,
      campaignDir: job.campaign.campaign_dir,
      imageRef: CAMPAIGN_IMAGE_REF,
      imageDigest: job.campaign.image_digest,
      evalsSha: job.campaign.evals_sha,
      bundleDir: loaded.config.credential_bundle.path,
      uid: who.uid,
      gid: who.gid,
      dockerWait: realDockerWait,
    });
    const exit = await runCampaignFn(job.campaign.campaign_dir, { spawner });
    updateJob(loaded, jobId, (current) => ({
      ...current,
      status: exit === 0 ? 'done' : 'failed',
      finished_at: new Date().toISOString(),
      result: {
        exit_code: exit,
        summary: `campaign controller exited ${exit} — the campaign journal is the outcome authority`,
      },
    }));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    try {
      updateJob(loaded, jobId, (current) => ({
        ...current,
        status: 'failed',
        finished_at: new Date().toISOString(),
        error: {
          code: error instanceof ApplianceError ? error.code : 'config_invalid',
          step: error instanceof ApplianceError ? error.step : 'campaign-worker',
          message,
        },
      }));
    } catch {
      // A record write failure must not mask the original error.
    }
    throw error;
  } finally {
    runLock?.release();
  }
}
```

Import `appendLog` from wherever `process.ts` defines/exports it (check `src/appliance/process.ts`; if private, export it). The controller runs IN this worker process; its `stream` writes land in the job's stdout log, giving `evals-appliance status <job-id>` something to show.

- [ ] **Step 4: Dispatch the detached worker by kind**

In `src/appliance/process.ts` `spawnDetachedWorker`, extend the inline eval script:

```javascript
const { readJob } = await import(${JSON.stringify(jobsModule)});
const job = readJob(loaded, jobId);
if (job.kind === 'campaign-run') {
  const { runCampaignWorker } = await import(${JSON.stringify(campaignRunModule)});
  await runCampaignWorker(loaded, jobId);
} else {
  await runWorker(loaded, jobId);
}
```

(`jobsModule`/`campaignRunModule` are `new URL('./jobs.ts' | './campaign-run.ts', import.meta.url).href`.)

- [ ] **Step 5: Cancel branch for campaign-run jobs**

In `src/appliance/process.ts` `cancelJob`, after the signal is accepted and before `waitForTerminalArtifact`, branch:

```typescript
  if (job.kind === 'campaign-run') {
    // A campaign job has no run/batch terminal artifact: the campaign
    // journal owns outcomes. Cancel is complete once the controller's
    // process group is verified dead; the container stops are the
    // controller's own (child 1: live-controller cancel only).
    const deadline = Date.now() + (options.graceMs ?? CANCEL_GRACE_MS);
    for (;;) {
      if (!jobProcessGroupAlive(loaded, readJob(loaded, jobId), runner)) {
        return updateJob(loaded, jobId, (current) => ({
          ...current,
          status: 'cancelled',
          finished_at: new Date().toISOString(),
          result: {
            exit_code: null,
            summary:
              'controller signalled and verified dead; campaign outcome lives in the campaign journal',
          },
        }));
      }
      if (Date.now() >= deadline) {
        return updateJob(loaded, jobId, (current) => ({
          ...current,
          status: 'stopping',
          result: {
            exit_code: null,
            summary: 'cancel signal sent; controller still live past the grace',
          },
        }));
      }
      await new Promise((r) => setTimeout(r, options.pollIntervalMs ?? CANCEL_POLL_INTERVAL_MS));
    }
  }
```

- [ ] **Step 6: Register the verb and action**

In `src/appliance/cli.ts`:

1. Add args type and action slot:

```typescript
export interface CampaignRunCommandArgs extends BaseCommandArgs {
  readonly campaignId: string;
}
```

Add to `ApplianceActions`:

```typescript
  readonly campaignRun: (
    args: CampaignRunCommandArgs,
  ) => ApplianceActionResult | Promise<ApplianceActionResult>;
```

2. Implement the action inside `createApplianceActions`:

```typescript
    campaignRun: async (args) => {
      const loaded = deps.loadCredentialConfig({ ensureState: true });
      const campaignId = args.campaignId;
      if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(campaignId)) {
        throw new ApplianceError(
          'config_invalid',
          'arguments',
          `campaign id must be a closed basename: ${campaignId}`,
        );
      }
      const campaignDir = join(loaded.config.evals.path, 'campaigns', campaignId);
      if (!existsSync(join(campaignDir, 'campaign.json'))) {
        throw new ApplianceError(
          'config_invalid',
          'campaign',
          `campaign not found under the evals checkout: ${campaignId}`,
        );
      }
      const imageDigest = imageDigestOf(deps.commandRunner, CAMPAIGN_IMAGE_REF);
      // The CLI argument is only the DIRECTORY lookup key (the registration's
      // collision-extended digest-prefix-plus-suite basename). The authoritative
      // identities — the full campaign_id digest and the frozen evals ref —
      // come from the campaign document itself.
      const campaignDoc = JSON.parse(readFileSync(join(campaignDir, 'campaign.json'), 'utf8')) as {
        campaign_id?: string;
        refs?: { evals?: string };
      };
      const docCampaignId = campaignDoc.campaign_id;
      const evalsSha = campaignDoc.refs?.evals;
      if (docCampaignId === undefined || docCampaignId.length === 0) {
        throw new ApplianceError(
          'config_invalid',
          'campaign',
          `campaign.json carries no campaign_id: ${campaignId}`,
        );
      }
      if (evalsSha === undefined || !/^[0-9a-f]{40}$/.test(evalsSha)) {
        throw new ApplianceError(
          'config_invalid',
          'campaign',
          `campaign.json carries no usable frozen evals ref: ${campaignId}`,
        );
      }
      const helperSha = currentCheckoutSha(loaded.config.evals.path, 'evals checkout', deps.commandRunner);
      const job = createJob(loaded, {
        kind: 'campaign-run',
        superpowersRef: evalsSha,
        argv: ['evals-appliance', 'campaign', 'run', campaignId],
        requester: requester(),
        credentialSelection: null,
        credentialScope: EMPTY_CREDENTIAL_SCOPE,
        credentialScopeSourceEvalsSha: null,
        campaign: {
          campaign_id: docCampaignId,
          campaign_dir: campaignDir,
          evals_sha: evalsSha,
          helper_sha: helperSha,
          image_ref: CAMPAIGN_IMAGE_REF,
          image_digest: imageDigest,
        },
      });
      deps.spawnDetachedWorker(loaded, job.job_id);
      return readJob(loaded, job.job_id);
    },
```

(The verb's `loadCredentialConfig` IS the bundle-availability check: a bundle fault fails typed before any job record.) The Task 14 test fixture's `campaign.json` must therefore set `campaign_id` to the same value the assertions expect (the fixture helper exposes it as `fx.campaignId`).

3. Register the command group in `createApplianceProgram`, after the `prune` command:

```typescript
  const campaign = program
    .command('campaign')
    .description('Campaign Appliance V2 (child 1: run only)');
  campaign
    .command('run <campaign-id>')
    .option('--json', 'emit JSON')
    .action((campaignId: string, options: JsonOption) => {
      const args = { ...baseArgs(options), campaignId };
      return handleAction(args, resolvedDeps, () => actions.campaignRun(args));
    });
```

(Match the surrounding registration style exactly — read the existing `program.command(...)` chain in `createApplianceProgram` first.)

- [ ] **Step 7: Run the tests to verify they pass**

Run: `bun test test/appliance-campaign-run.test.ts test/appliance-cli.test.ts test/appliance-process.test.ts`
Expected: PASS.

- [ ] **Step 8: Run the full gate and commit**

Run: `bun run check && bun run quorum check && git diff --check`

```bash
git add src/appliance/campaign-run.ts src/appliance/process.ts src/appliance/cli.ts test/appliance-campaign-run.test.ts
git commit -m "feat(appliance): add the campaign run verb and controller worker"
```

---

### Task 15: Linux Docker integration suite

**Files:**
- Create: `test/linux/campaign-attempt-docker.test.ts`
- Create: `test/linux/fixtures/fake-provider.ts`, `test/linux/fixtures/fake-coding-agent`, harness helpers in the same directory

**Interfaces:**
- Consumes: everything from Tasks 1–14, a real `scripts/evals-container build` image, real Docker, real locks and journal.
- Produces: the observed-fact proofs the parent spec's journal vocabulary (child 3) will freeze.

This suite runs ONLY with `QUORUM_DOCKER_INTEGRATION=1` on a Linux host with Docker (the appliance or a Linux devbox). Every test begins:

```typescript
import { expect, test, beforeAll } from 'bun:test';
const enabled = process.env.QUORUM_DOCKER_INTEGRATION === '1';
const it = enabled ? test : test.skip;
```

- [ ] **Step 1: Build the harness fixtures**

- `fake-provider.ts`: a `Bun.serve` HTTP server speaking the minimum chat-completions surface Gauntlet's grader and the subject's model client need (canned assistant messages, usage blocks). Records every request's `Authorization` header to a per-run file. This is the "fake provider executable".
- `fake-coding-agent`: an executable script that behaves like an interactive TUI subject — reads typed input, emits canned assistant turns, records its complete environment to `$QUORUM_ATTEMPT_DIR/subject-evidence/env.txt`, and (for the teardown test) can be told to daemonize a survivor process. Tune against the real Gauntlet TUI adapter on the Linux host; the child spec explicitly expects this iteration ("on the Linux devbox during development").
- A one-cell, one-sample exploratory suite + campaign registered from fixture files under `test/linux/fixtures/` (mirror the registration fixture style of `test/campaign-registration.test.ts`).

- [ ] **Step 2: Write the integration assertions**

Implement each child-spec proof as one `it(...)`:

1. PID 1 is the init, Quorum its direct child, container exits with Quorum's status (`docker inspect` + `/proc` walk inside the container).
2. A fake Coding-Agent left alive under a daemonized tmux server does NOT keep the container alive after Quorum exits.
3. `docker stop` drives the graceful stopped path (Task 9): the run dir gains a stopped verdict, `exit.json` records it, and the fake Coding-Agent is gone afterward.
4. SIGKILL of Quorum inside the container leaves `stdout.log`/`stderr.log` readable on the host containing the bytes written before the kill (mode `0600`).
5. The worker sees exactly the audited mounts: from inside the container, the bundle path, the campaign journal, a sibling attempt, and the Docker socket are all absent (`test -e` / mount table walk).
6. Two parallel attempts: distinct `TMUX_TMPDIR` roots; stopping attempt A leaves attempt B's tmux server and fake Coding-Agent running.
7. The fake subject observes only subject values; the fake grader (fake-provider request headers) only grader values.
8. No credential value appears in: `docker inspect` output of the created container, the journal bytes, the job record JSON, or the log paths (grep each for both canary values).
9. A complete run commits a manifest, the host publishes it, `results/<run-id>/verdict.json` exists, and the journal holds `run_allocated` (container arm) plus the terminal event with that run id.

- [ ] **Step 3: Run the suite on a Linux Docker host**

Run: `QUORUM_DOCKER_INTEGRATION=1 bun test test/linux/`
Expected: PASS. Iterate the fake-agent/gauntlet interaction until green; record every observed behavior the child 3 contracts must honor in notes for Task 16's experiment-log entry. Do NOT run this on macOS CI — it skips.

- [ ] **Step 4: Run the portable gate everywhere else**

Run: `bun run check && bun run quorum check && git diff --check`
Expected: PASS (the suite skips without the env var).

- [ ] **Step 5: Commit**

```bash
git add test/linux/
git commit -m "test(campaign): add the Linux Docker integration suite for attempt containers"
```

---

### Task 16: Runbook section

**Files:**
- Modify: `docs/appliance-runbook.md`

- [ ] **Step 1: Write the `campaign run` section**

Add after the existing live-job sections, documenting exactly what child 1 ships:

- Host-side registration prerequisite (first host-side registration): export `GAUNTLET_ROOT=/srv/quorum/gauntlet` and `SUPERPOWERS_ROOT=/srv/quorum/superpowers`, source the blessed bundle's `credentials.env` into the register shell so the key-presence check passes; run `quorum campaign register …` as `quorum-runner` from the evals checkout. State why registration runs on the host (snapshot absolute paths are the mount paths).
- `evals-appliance campaign run <campaign-id> [--json]`: what the job record carries, what exit zero means (recorded, not completed), how to follow it (`evals-appliance status <job-id>`, `docker ps --filter label=quorum.campaign_id=<id>`).
- Cancellation: `evals-appliance cancel <job-id>` signals the live controller, which stops its containers; outcomes live in the campaign journal. Cancel after controller death is child 2.
- The config field `live_spend_lock`: the single host-wide live-spend lock path every spender (campaign controller, break-glass `quorum run`/`run-all`) must share; record the production value `/var/lib/quorum/live-spend.lock.d`.
- What child 1 deliberately does NOT cover (crash reconciliation, marker-first cancel, credential generations, helper verbs beyond `campaign run`) with pointers to children 2–4.

- [ ] **Step 2: Run the gate and commit**

Run: `bun run check && bun run quorum check && git diff --check`

```bash
git add docs/appliance-runbook.md
git commit -m "docs(appliance): document the campaign run verb"
```

---

### Task 17: Live proof (requires Drew's explicit go-ahead)

**Gate:** STOP HERE and ask Drew. This task spends real money (one attempt) on the production appliance. Do not proceed on any other authority.

**Files:**
- Create: `docs/experiments/2026-09-XX-campaign-appliance-child1-live-proof.md` (date it the day it runs)

- [ ] **Step 1: Preflight on the appliance**

As `quorum-runner` on the appliance host:

```bash
evals-appliance doctor --json
scripts/evals-container build   # if the image is absent or stale
QUORUM_DOCKER_INTEGRATION=1 bun test test/linux/   # integration suite green on THIS host first
```

- [ ] **Step 2: Host-side registration of a one-cell, one-sample exploratory suite**

```bash
export GAUNTLET_ROOT=/srv/quorum/gauntlet
export SUPERPOWERS_ROOT=/srv/quorum/superpowers
source /srv/quorum/config/blessed/credentials.env   # path per the runbook
quorum campaign register suites/<one-cell-exploratory>.yaml --confirm
```

Record the printed campaign id and directory.

- [ ] **Step 3: Run through the helper and observe**

```bash
evals-appliance campaign run <campaign-id> --json
evals-appliance status <job-id>
docker ps --filter label=quorum.campaign_id=<campaign-id>
```

Expect: the controller live, exactly one `quorum-attempt-*` container with the three labels.

- [ ] **Step 4: Verify the durable evidence after container exit**

- `results/<run-id>/verdict.json` and `manifest.json` exist; the verdict's pass/fail is IRRELEVANT — a real verdict from a real model is the proof.
- The journal holds `run_allocated` with `container_id` + `image_digest` and the terminal event with the run id: `quorum campaign report <campaign-dir>` reads it.
- `docker ps -a` shows the container exited, not running; the `.stage` directory is gone; `stdout.log`/`stderr.log` are mode `0600` and non-empty.

- [ ] **Step 5: Seal the one-sample campaign**

```bash
quorum campaign report <campaign-dir>
```

- [ ] **Step 6: Write the experiment-log entry**

Record: image digest, evals SHA, campaign id, run id, container id, timing, every observed behavior child 3 must honor (tmux teardown timing, log durability, mount walk results), and any deviation from this plan. Negative observations at equal billing.

- [ ] **Step 7: Commit the experiment log**

```bash
git add docs/experiments/
git commit -m "docs(experiments): record the child 1 appliance live proof"
```

---

## Self-Review Notes (written by the plan author)

**Spec coverage:** all 12 in-scope items map to tasks — spawner (2–4), handle + payload (1), entrypoint (5), durable logs + following (3), credential projection (6), mounts (2, 6), manifest commit (7), publication (8), container stop (4, 10, 11), appliance verb (13–14), integration suite (15), live attempt (17). All 12 acceptance criteria are asserted by at least one test or live-proof step; criterion 12 (Phase 1 unchanged) is covered by the full existing suite staying green at every commit.

**Deviations from the child spec, recorded deliberately:**
1. Task order 5/6 (dispatcher routing / manifest+publication) is swapped so publication exists before the dispatcher consumes it — every commit stays meaningful.
2. `docker wait` bypasses the synchronous `CommandRunner` via the injected `DockerWait` seam: a synchronous wait would block the controller's event loop (lock heartbeats, parallel attempts). The seam stays fully fakeable.
3. The job record's `request.superpowers_ref` carries the campaign's frozen evals SHA for `campaign-run` jobs (informational sentinel, mirroring `import`'s precedent); the `campaign` block is the authority.
4. The entrypoint additionally reads `QUORUM_ATTEMPT_DIR`, `QUORUM_SUBJECT_FILE`, `QUORUM_GRADER_FILE` (non-secret `--env` entries) — the spec's env allowlist is extended accordingly.
5. SIGTERM parity (Task 9) is required by the parent spec's single stop path and child 1's `docker stop` assertion, though absent from the child's file list — recorded here.
6. The live-spend lock gains an optional `live_spend_lock` config field; the worker exports it in-process. Without it the detached worker's `HOME`-relative default would not match break-glass spenders.

**Known unknowns (flagged for implementation, not gaps):** the fake coding-agent ↔ real Gauntlet TUI interaction (Task 15) requires iteration on a Linux host; the runner `RunnerError` stage literal for manifest faults must match an existing stage (Task 7 Step 3); the `appendLog` export location in `src/appliance/process.ts` must be verified (Task 14 Step 3).
