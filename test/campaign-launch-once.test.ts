import { afterEach, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { startCampaignOnce } from '../src/appliance/campaign-run.ts';
import {
  campaignProcesses,
  cancelCampaign,
} from '../src/campaign/cancellation.ts';
import { readProjection } from '../src/campaign/execution-journal.ts';
import {
  publishCancelIntent,
  readHostClaim,
} from '../src/campaign/ownership.ts';
import { lifecycleFixture } from './fixtures/core-comparison/lifecycle.ts';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const f = lifecycleFixture();
  roots.push(f.root);
  const marker = join(f.root, 'admitted');
  const module = join(f.root, 'controller.ts');
  writeFileSync(
    module,
    `export async function controller(context) { context.assertAdmission(); await Bun.write(${JSON.stringify(marker)}, context.start.start_id); }`,
  );
  return { ...f, marker, target: { module, exportName: 'controller' } };
}
for (const cut of [
  'started',
  'claim_published',
  'controller_bound',
  'leases_released',
  'launcher_released',
] as const) {
  test(`loss after ${cut} never admits or consumes a second start`, async () => {
    const f = fixture();
    const result = await startCampaignOnce(f, {
      target: f.target,
      onBoundary: (boundary) => {
        if (boundary === cut) throw Error('launcher lost');
      },
    });
    expect(result.kind).toBe('refused');
    expect((await startCampaignOnce(f, { target: f.target })).kind).toBe(
      'refused',
    );
    await Bun.sleep(150);
    expect(existsSync(f.marker)).toBe(false);
    expect(readProjection(f.campaignDir).start).not.toBeNull();
    expect(
      readHostClaim({ lockPath: f.loaded.config.live_spend_lock! }) !== null,
    ).toBe(cut !== 'started');
  });
}
test('two racing invocations release one real child after durable binding', async () => {
  const f = fixture();
  const results = await Promise.all([
    startCampaignOnce(f, { target: f.target }),
    startCampaignOnce(f, { target: f.target }),
  ]);
  expect(results.filter((r) => r.kind === 'launched')).toHaveLength(1);
  for (let i = 0; i < 400 && !existsSync(f.marker); i++) await Bun.sleep(20);
  expect(existsSync(f.marker)).toBe(true);
  await Bun.sleep(100);
  const p = readProjection(f.campaignDir);
  expect(p.controller?.pid).toBeGreaterThan(1);
  expect(p.controller?.birth).toBeTruthy();
  expect(p.controller?.boot_id).toBeTruthy();
}, 10_000);
test('cancel after parent final check but before release fences child admission', async () => {
  const f = fixture();
  await startCampaignOnce(f, {
    target: f.target,
    onBoundary: (boundary) => {
      if (boundary === 'launcher_released') {
        const p = readProjection(f.campaignDir);
        publishCancelIntent(f.campaignDir, {
          campaign_id: p.experiment.campaign_id,
          input_digest: p.experiment.input_digest,
          start_id: p.start!.start_id,
          requested_at: new Date().toISOString(),
          controller_loss_established: false,
          reason: 'test cancel',
        });
      }
    },
  });
  await Bun.sleep(200);
  expect(existsSync(f.marker)).toBe(false);
});
test('missing controller target refuses before consuming start', async () => {
  const f = fixture();
  expect(
    (
      await startCampaignOnce(f, {
        target: {
          module: join(f.root, 'missing.ts'),
          exportName: 'controller',
        },
      })
    ).kind,
  ).toBe('refused');
  expect(readProjection(f.campaignDir).start).toBeNull();
});

for (const cut of ['started', 'claim_published'] as const) {
  test(`actual launcher exit after ${cut} leaves the start consumed`, async () => {
    const f = fixture();
    const module = new URL('../src/appliance/campaign-run.ts', import.meta.url)
      .href;
    const configModule = new URL('../src/appliance/config.ts', import.meta.url)
      .href;
    const script = `const {startCampaignOnce}=await import(${JSON.stringify(module)});const {loadStateConfig}=await import(${JSON.stringify(configModule)}); await startCampaignOnce({loaded:loadStateConfig(${JSON.stringify(f.loaded.configPath)}),jobId:'crashed',campaignDir:${JSON.stringify(f.campaignDir)}},{target:${JSON.stringify(f.target)},onBoundary:b=>{if(b===${JSON.stringify(cut)})process.exit(7)}});`;
    const child = spawnSync(process.execPath, ['--eval', script], {
      encoding: 'utf8',
    });
    expect(child.status).toBe(7);
    expect((await startCampaignOnce(f, { target: f.target })).kind).toBe(
      'refused',
    );
    expect(existsSync(f.marker)).toBe(false);
    expect(
      readHostClaim({ lockPath: f.loaded.config.live_spend_lock! }) !== null,
    ).toBe(cut === 'claim_published');
  });
}
test('missing emergency reserve refuses before consuming start', async () => {
  const f = fixture();
  rmSync(join(f.campaignDir, '.ballast'));
  expect((await startCampaignOnce(f, { target: f.target })).kind).toBe(
    'refused',
  );
  expect(readProjection(f.campaignDir).start).toBeNull();
});
test('long-lived launcher role release permits later cancellation after child exit', async () => {
  const f = fixture();
  await startCampaignOnce(f, { target: f.target });
  const receipt = JSON.parse(
    readFileSync(join(f.campaignDir, 'launcher-released.json'), 'utf8'),
  );
  for (
    let i = 0;
    i < 200 && campaignProcesses.observe(receipt.controller) !== 'dead';
    i++
  )
    await Bun.sleep(20);
  expect(campaignProcesses.observe(receipt.controller)).toBe('dead');
  const runtime = () => ({
    create: async () => {
      throw Error('forbidden');
    },
    start: async () => {
      throw Error('forbidden');
    },
    inspectOwned: async () => ({ kind: 'absent' as const }),
    stop: async () => {
      throw Error('no workers');
    },
  });
  const cancelled = await cancelCampaign(f, { runtime });
  expect(cancelled.kind).toBe('terminated');
  expect(cancelled.status).toMatchObject({
    state: 'interrupted',
    next_action: 'register',
  });
}, 10_000);

test('ended controller permanently refuses late admission before releasing ownership', async () => {
  const f = fixture();
  const cancellation = new URL(
    '../src/campaign/cancellation.ts',
    import.meta.url,
  ).href;
  writeFileSync(
    f.target.module,
    `const {completeControllerTermination}=await import(${JSON.stringify(cancellation)});export async function controller(context){context.writer.commitTransition({type:'ended',transition_id:'end',at:new Date().toISOString(),payload:{outcome:'interrupted',reason:'test stop',cancel_intent:null}});let refused=false;try{context.assertAdmission();}catch{refused=true;}if(!refused)throw Error('late admission');completeControllerTermination({...context,assertNoUnsettledStarts:()=>{}});await Bun.write(${JSON.stringify(f.marker)},'refused');}`,
  );
  expect((await startCampaignOnce(f, { target: f.target })).kind).toBe(
    'launched',
  );
  for (let i = 0; i < 400 && !existsSync(f.marker); i++) await Bun.sleep(20);
  expect(readFileSync(f.marker, 'utf8')).toBe('refused');
  expect(
    readHostClaim({ lockPath: f.loaded.config.live_spend_lock! }),
  ).toBeNull();
}, 10_000);
