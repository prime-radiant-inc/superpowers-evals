import { expect, test } from 'bun:test';
import {
  clockNowMs,
  type HostStats,
  type HostStatsProbe,
} from '../src/campaign/host-stats.ts';
import type {
  CampaignChildSpec,
  ChildSpawner,
  SpawnedCampaignChild,
} from '../src/campaign/spawn.ts';
import { FakeClock } from '../src/scheduler/clock.ts';

test('clockNowMs derives ts_ms from the seconds-based Clock seam', () => {
  const clock = new FakeClock(0);
  expect(clockNowMs(clock)).toBe(0);
  clock.advance(1.5);
  expect(clockNowMs(clock)).toBe(1500);
  clock.advance(0.0004); // 1.5004s -> 1500ms (round-half-even is fine: assert stable derivation)
  expect(clockNowMs(clock)).toBe(1500);
});

test('HostStatsProbe is injectable: a fake series drives consumers', () => {
  const series: HostStats[] = [
    {
      ts_ms: 1000,
      load1: 0.5,
      mem_available_bytes: 8 * 2 ** 30,
      mem_total_bytes: 16 * 2 ** 30,
      swap_used_bytes: 0,
      swap_total_bytes: 2 * 2 ** 30,
      process_count: 100,
      pid_max: 4_194_304,
      disk_free_bytes: 100 * 2 ** 30,
      disk_total_bytes: 494 * 2 ** 30,
    },
  ];
  const probe: HostStatsProbe = {
    sample: (nowMs: number) => series[0] ?? { ...series[0]!, ts_ms: nowMs },
  };
  expect(probe.sample(1000).load1).toBe(0.5);
});

test('ChildSpawner is injectable: fake children carry scripted protocol lines', () => {
  const spawned: CampaignChildSpec[] = [];
  const spawner: ChildSpawner = {
    spawn(spec: CampaignChildSpec) {
      spawned.push(spec);
      const exitCbs: ((info: {
        code: number | null;
        signal: NodeJS.Signals | null;
      }) => void)[] = [];
      // A full, typed SpawnedCampaignChild plus the test's emitExit driver —
      // an intersection type, no cast.
      const handle: SpawnedCampaignChild & { emitExit(code: number): void } = {
        handle: { kind: 'process', pgid: 4242 },
        stdoutLines: ['run_allocated: run-x'],
        stderrLines: [],
        onExit(cb) {
          exitCbs.push(cb);
        },
        onStdoutLine(cb) {
          for (const line of ['run_allocated: run-x']) cb(line);
        },
        onStderrLine() {},
        emitExit(code: number) {
          for (const cb of exitCbs) cb({ code, signal: null });
        },
      };
      return handle;
    },
    kind: 'process',
  };
  const child = spawner.spawn({
    command: 'bun',
    args: ['run', 'evals/src/cli/index.ts', 'run', 'scn'],
    cwd: '/camp',
    env: {},
  });
  expect(spawned).toHaveLength(1);
  expect(child.handle.kind).toBe('process');
  if (child.handle.kind === 'process') expect(child.handle.pgid).toBe(4242);
});
