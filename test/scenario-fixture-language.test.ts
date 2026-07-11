import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dir, '..');

function read(rel: string): string {
  return readFileSync(join(ROOT, rel), 'utf8');
}

function scenarioFiles(rel: string): string[] {
  const root = join(ROOT, rel);
  const files: string[] = [];
  const visit = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile() && statSync(path).isFile()) files.push(path);
    }
  };
  visit(root);
  return files;
}

test('active non-planted fixtures do not advertise fake backends', () => {
  const checkedFiles = [
    'scenarios/triggering-executing-plans/setup.sh',
    'scenarios/mid-conversation-skill-invocation/setup.sh',
    'scenarios/writing-plans-no-spec-conversational/setup.sh',
    'scenarios/cost-session-timeout-boundary/setup.sh',
  ];

  for (const rel of checkedFiles) {
    expect(read(rel), rel).not.toMatch(/\b(stub|placeholder|no-op)\b/i);
  }
});

test('Serf builder scenario is a neutral full-tier SDD exercise', () => {
  const scenario = 'scenarios/serf-builder-fractals';
  expect(existsSync(join(ROOT, scenario))).toBe(true);

  const story = read(`${scenario}/story.md`);
  const checks = read(`${scenario}/checks.sh`);
  expect(checks).toStartWith('# coding-agents: serf\n# os: linux\n');
  expect(story).toMatch(/^status: ready$/m);
  expect(story).toMatch(/^quorum_tier: full$/m);
  expect(story.match(/superpowers:subagent-driven-development/g)).toHaveLength(
    1,
  );
  expect(story).not.toMatch(/\bTask\s+\d+\s*:/i);
  expect(story).toContain('implementer');
  expect(story).toContain('spec-compliance');
  expect(story).toContain('code-quality');
  expect(story).toContain('main checkout');
});

test('Serf builder scenario contains only public-safe fixture material', () => {
  const scenario = 'scenarios/serf-builder-fractals';
  expect(existsSync(join(ROOT, scenario))).toBe(true);

  const text = scenarioFiles(scenario)
    .map((path) => readFileSync(path, 'utf8'))
    .join('\n');
  const tokenDigests = new Set(
    (text.match(/[A-Za-z0-9][A-Za-z0-9._-]*/g) ?? []).map((token) =>
      createHash('sha256').update(token).digest('hex'),
    ),
  );
  expect(text).not.toMatch(/\/(?:Users|home)\/[A-Za-z0-9._-]+\//);
  expect(tokenDigests).not.toContain(
    '30bf172c66e520e24905aee7f9984cb3429fb6bdf3975bbbf1df38ab2c9952bc',
  );
  expect(text).not.toMatch(/https?:\/\/(?:\d{1,3}\.){3}\d{1,3}(?::\d+)?/);
  expect(text).not.toMatch(/[?&]run=[A-Za-z0-9._-]+/);
  expect(text).not.toMatch(/\b[A-Z][A-Z0-9_]*API_KEY\s*=/);
  expect(text).not.toMatch(/\bsk-[A-Za-z0-9_-]{12,}/);
  expect(text).not.toContain('sidecar-write-secret-marker');
});

test('branch campaign tests and fixtures contain no private candidate identities', () => {
  const publicCampaignFiles = [
    'test/agent-serf.test.ts',
    'test/cli-costs.test.ts',
    'test/cli-list-check.test.ts',
    'test/cli-run-all.test.ts',
    'test/cli-run-sigint.test.ts',
    'test/cli-run.test.ts',
    'test/credential-file.test.ts',
    'test/credential-resolve.test.ts',
    'test/credential-schema.test.ts',
    'test/economics.test.ts',
    'test/fixtures/openrouter-generation-dated-model.json',
    'test/fixtures/openrouter-generation-valid.json',
    'test/fixtures/serf-campaign-credentials.yaml',
    'test/openrouter-generations.test.ts',
    'test/run-all-batch-index.test.ts',
    'test/run-all-matrix.test.ts',
    'test/run-all.test.ts',
    'test/runner-credential.test.ts',
    'test/runner-context.test.ts',
    'test/runner-identity.test.ts',
    'test/runner-phase.test.ts',
    'test/scaffold.test.ts',
    'test/scenario-manifest.test.ts',
    'test/scenario-pinning.test.ts',
  ];
  const forbiddenDigests = new Set([
    '0c72ffa4e7c08e8080bc28453dbc5e61bbcda0113f1f7803d5c3c512b33963b3',
    '224d644a575db628efd2af84a0538add090fdd77c95bcc13b5959a025cea7b5e',
    '0691ed45b103d0df5704b62547a7263af46a6d3edd3b3611b0910bd34f531f6a',
    '22df1c188b2f4e2e12e27a0850250d38c24c8580906c808d20c024673b90330d',
    '9e4d9e9daea239d9e5eeab833369741363e184795fab233d9f618a3bc8274fc4',
    'b1e91b1a7e09b96b77ca0105225ead59c7c9a3a3a27150380aaffca2a76fd9cc',
    '0a50a07586c3c66db4cc299f72554c30dd2123c608fbbcf6b2fa87c37c1e5b4e',
    '10d0a8a3082d9de83e8f29f66cd6a890faa05f2f09397e23f37cbce0e8d4fcd7',
  ]);

  for (const rel of publicCampaignFiles) {
    const tokens = read(rel).match(/[A-Za-z0-9@._/-]+/g) ?? [];
    const found = tokens.find((token) =>
      forbiddenDigests.has(createHash('sha256').update(token).digest('hex')),
    );
    expect(found, rel).toBeUndefined();
  }
});

test('quorum smoke story uses the neutral Coding-Agent actor', () => {
  const story = read('scenarios/00-quorum-smoke-hello-world/story.md');
  expect(story).toContain('Drive the Coding-Agent through this trivial task');
  expect(story).toContain('Invoke the Coding-Agent exactly once.');
  expect(story).toContain('Do not retry the Coding-Agent if it fails.');
  expect(story).not.toMatch(/Coding-Agent \([^)]+\)/);
});

test('documented external-campaign smoke command includes draft scenarios', () => {
  const readme = read('README.md');
  const smokeCommand = readme.match(
    /quorum run-all \\\n(?:.*\\\n)*?\s+--scenarios 00-quorum-smoke-hello-world \\\n(?:.*\n)*?\s+--jobs 1/,
  )?.[0];

  expect(smokeCommand).toBeDefined();
  expect(smokeCommand).toContain('--include-drafts');
});
