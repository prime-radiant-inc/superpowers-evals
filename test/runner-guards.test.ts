import { expect, test } from 'bun:test';
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { runScenario } from '../src/runner/index.ts';

// Region 1 — early guards in runInner, before any side effect (provisioning,
// gauntlet). These tests select the claude agent against the REAL coding-agents
// dir (the claude.yaml + context fixtures are present there) but each one trips
// a guard BEFORE invokeGauntlet, so the mock-gauntlet is never reached — no
// fixture env is required.

const REAL_CODING_AGENTS = resolve(import.meta.dir, '..', 'coding-agents');

function freshOutRoot(): string {
  return mkdtempSync(join(tmpdir(), 'out-'));
}

// A scenario dir with the requested set of files present. Always writes story.md
// unless `omitStory`; checks.sh content is configurable; setup.sh is a no-op.
function makeScenarioDir(opts: {
  omitStory?: boolean;
  omitChecks?: boolean;
  checksContent?: string;
}): string {
  const dir = mkdtempSync(join(tmpdir(), 'scn-'));
  if (!opts.omitStory) {
    writeFileSync(
      join(dir, 'story.md'),
      '---\nquorum_max_time: 1m\n---\nDo the thing.\n',
    );
  }
  writeFileSync(join(dir, 'setup.sh'), '#!/usr/bin/env bash\n:\n');
  chmodSync(join(dir, 'setup.sh'), 0o755);
  if (!opts.omitChecks) {
    writeFileSync(
      join(dir, 'checks.sh'),
      opts.checksContent ?? 'pre() { :; }\npost() { :; }\n',
    );
  }
  return dir;
}

// Run with ANTHROPIC_API_KEY + SUPERPOWERS_ROOT set (the claude.yaml needs them
// to even reach the guard sites in some cases), restoring env afterward. PATH is
// NOT pointed at the mock-gauntlet, so any test that reaches invokeGauntlet would
// fail loudly — every Region-1 guard must short-circuit before that.
async function runGuard(args: {
  scenarioDir: string;
  codingAgent?: string;
  noPath?: boolean;
}): Promise<Awaited<ReturnType<typeof runScenario>>> {
  const outRoot = freshOutRoot();
  const prevKey = process.env['ANTHROPIC_API_KEY'];
  const prevRoot = process.env['SUPERPOWERS_ROOT'];
  process.env['ANTHROPIC_API_KEY'] = 'sk-test';
  process.env['SUPERPOWERS_ROOT'] = mkdtempSync(join(tmpdir(), 'sproot-'));
  try {
    return await runScenario({
      scenarioDir: args.scenarioDir,
      codingAgent: args.codingAgent ?? 'claude',
      codingAgentsDir: REAL_CODING_AGENTS,
      outRoot,
    });
  } finally {
    if (prevKey === undefined) delete process.env['ANTHROPIC_API_KEY'];
    else process.env['ANTHROPIC_API_KEY'] = prevKey;
    if (prevRoot === undefined) delete process.env['SUPERPOWERS_ROOT'];
    else process.env['SUPERPOWERS_ROOT'] = prevRoot;
  }
}

test('A-missing-checks-sh: missing checks.sh -> setup indeterminate before any run', async () => {
  const scenarioDir = makeScenarioDir({ omitChecks: true });
  const { verdict, runDir } = await runGuard({ scenarioDir });
  expect(verdict.final).toBe('indeterminate');
  expect(verdict.final_reason).toBe('scenario missing checks.sh');
  expect(verdict.error?.stage).toBe('setup');
  expect(verdict.error?.message).toBe('checks.sh not found');
  // No agent run happened: no gauntlet layer, no coding-agent-config dir.
  expect(verdict.gauntlet).toBe(null);
  // verdict.json persisted.
  const persisted = JSON.parse(
    readFileSync(join(runDir, 'verdict.json'), 'utf8'),
  );
  expect(persisted.final).toBe('indeterminate');
});

test('A-coding-agents-directive: excluded agent -> immediate indeterminate', async () => {
  const scenarioDir = makeScenarioDir({
    checksContent:
      '# coding-agents: codex,gemini\npre() { :; }\npost() { :; }\n',
  });
  const { verdict } = await runGuard({ scenarioDir, codingAgent: 'claude' });
  expect(verdict.final).toBe('indeterminate');
  expect(verdict.final_reason).toBe('requires coding-agents: codex, gemini');
  expect(verdict.gauntlet).toBe(null);
});

test('A-coding-agents-directive: included agent passes the gate (reaches preflight)', async () => {
  // claude is in the allowlist; the directive gate must NOT short-circuit. The
  // next guard (binary preflight) will fire because PATH lacks claude here, but
  // crucially the final_reason is NOT the directive message.
  const scenarioDir = makeScenarioDir({
    checksContent: '# coding-agents: claude\npre() { :; }\npost() { :; }\n',
  });
  const { verdict } = await runGuard({ scenarioDir, codingAgent: 'claude' });
  expect(verdict.final_reason).not.toBe('requires coding-agents: claude');
});

test('A-story-md-missing: missing story.md -> clean runner error, not raw ENOENT', async () => {
  const scenarioDir = makeScenarioDir({ omitStory: true });
  const { verdict } = await runGuard({ scenarioDir });
  expect(verdict.final).toBe('indeterminate');
  expect(verdict.error?.stage).toBe('setup');
  expect(verdict.final_reason).toContain('story.md missing');
});

test('A-x-missing-agent-yaml: unknown coding-agent -> clean message, not ENOENT', async () => {
  const scenarioDir = makeScenarioDir({});
  const { verdict } = await runGuard({
    scenarioDir,
    codingAgent: 'does-not-exist',
  });
  expect(verdict.final).toBe('indeterminate');
  expect(verdict.final_reason).toContain('unknown coding-agent');
  expect(verdict.final_reason).toContain('does-not-exist');
  // The leaked raw ENOENT message must NOT appear.
  expect(verdict.final_reason).not.toContain('ENOENT');
});

test('A-x-claude-binary-preflight: claude not on PATH -> setup indeterminate', async () => {
  const scenarioDir = makeScenarioDir({});
  // Point PATH at an empty dir so `claude` cannot be found — but keep the system
  // bin dirs (bash/env live there) so setup.sh still runs and the preflight, not
  // a setup-script spawn failure, is what fires. Restore afterward.
  const emptyBin = mkdtempSync(join(tmpdir(), 'emptybin-'));
  const prevPath = process.env['PATH'];
  process.env['PATH'] = `${emptyBin}:/usr/bin:/bin`;
  try {
    const { verdict } = await runGuard({ scenarioDir });
    expect(verdict.final).toBe('indeterminate');
    expect(verdict.error?.stage).toBe('setup');
    expect(verdict.final_reason).toContain('not on PATH');
  } finally {
    if (prevPath === undefined) delete process.env['PATH'];
    else process.env['PATH'] = prevPath;
  }
});

test('A-launch-cwd-sentinel: bogus .quorum-launch-cwd path -> runner error', async () => {
  // setup.sh writes a sentinel naming a path that does not exist. The runner must
  // raise before launching gauntlet (which here is absent from PATH anyway). We
  // need claude on PATH to pass the preflight, so point PATH at a dir holding a
  // dummy `claude`, plus the mock-gauntlet (never reached).
  const scenarioDir = mkdtempSync(join(tmpdir(), 'scn-'));
  writeFileSync(
    join(scenarioDir, 'story.md'),
    '---\nquorum_max_time: 1m\n---\nDo the thing.\n',
  );
  const bogus = join(tmpdir(), 'definitely-not-a-real-dir-quorum-xyz');
  writeFileSync(
    join(scenarioDir, 'setup.sh'),
    `#!/usr/bin/env bash\nprintf '%s' '${bogus}' > "$1/.quorum-launch-cwd"\n`,
  );
  // setup.sh receives workdir as $1? No — runSetup runs with cwd=workdir. Use a
  // sentinel in the cwd.
  writeFileSync(
    join(scenarioDir, 'setup.sh'),
    `#!/usr/bin/env bash\nprintf '%s' '${bogus}' > .quorum-launch-cwd\n`,
  );
  chmodSync(join(scenarioDir, 'setup.sh'), 0o755);
  writeFileSync(
    join(scenarioDir, 'checks.sh'),
    'pre() { :; }\npost() { :; }\n',
  );

  // Provide a fake claude on PATH so the binary preflight passes.
  const binDir = mkdtempSync(join(tmpdir(), 'bin-'));
  writeFileSync(join(binDir, 'claude'), '#!/usr/bin/env bash\n:\n');
  chmodSync(join(binDir, 'claude'), 0o755);
  // Also stub gauntlet so that if the guard FAILS to fire, we don't shell out to
  // a real gauntlet; a stub that exits non-zero produces a different (gauntlet)
  // stage, so the assertion below still distinguishes the launch-cwd guard.
  writeFileSync(join(binDir, 'gauntlet'), '#!/usr/bin/env bash\nexit 1\n');
  chmodSync(join(binDir, 'gauntlet'), 0o755);

  const prevPath = process.env['PATH'];
  process.env['PATH'] = `${binDir}:${process.env['PATH'] ?? ''}`;
  try {
    const { verdict } = await runGuard({ scenarioDir });
    expect(verdict.final).toBe('indeterminate');
    expect(verdict.final_reason).toContain('.quorum-launch-cwd');
    expect(verdict.final_reason).toContain("doesn't exist");
  } finally {
    if (prevPath === undefined) delete process.env['PATH'];
    else process.env['PATH'] = prevPath;
  }
});
