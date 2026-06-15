import { expect, test } from 'bun:test';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { resolveAgent } from '../src/agents/index.ts';
import type { AgentConfig } from '../src/contracts/agent-config.ts';
import { makeTempHome } from './provision-helpers.ts';

// The claude.yaml surface the adapter depends on. required_env carries
// ANTHROPIC_API_KEY, the trigger for the per-run env-file + API-key approval.
function claudeConfig(overrides?: Partial<AgentConfig>): AgentConfig {
  return {
    name: 'claude',
    binary: 'claude',
    agent_config_env: 'CLAUDE_CONFIG_DIR',
    home_config_subdir: '.claude',
    session_log_dir: '${CLAUDE_CONFIG_DIR}',
    session_log_glob: '*.jsonl',
    normalizer: 'claude',
    required_env: ['ANTHROPIC_API_KEY', 'SUPERPOWERS_ROOT'],
    runtime_family: 'claude',
    ...overrides,
  };
}

const API_KEY = 'sk-ant-0123456789abcdefghijklmnopqrstuvwxyz';

// Set (or delete, for undefined) env vars the adapter reads via env.ts ->
// process.env, run body, then restore. env.ts has no setter; test/agent-*.ts
// is exempted from noProcessEnv in biome.json.
function withEnv(
  vars: Record<string, string | undefined>,
  body: () => void,
): void {
  const keys = Object.keys(vars);
  const prev: Record<string, string | undefined> = {};
  for (const key of keys) {
    prev[key] = process.env[key];
    const value = vars[key];
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
  try {
    body();
  } finally {
    for (const key of keys) {
      const original = prev[key];
      if (original === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = original;
      }
    }
  }
}

// Seed a claude home skeleton at skeletonRoot/<family>-home-skeleton with the
// given .claude.json contents (mirrors coding-agents/claude-home-skeleton).
function seedSkeleton(skeletonRoot: string, claudeJson: unknown): void {
  const skel = join(skeletonRoot, 'claude-home-skeleton');
  mkdirSync(skel, { recursive: true });
  writeFileSync(join(skel, '.claude.json'), JSON.stringify(claudeJson));
}

// B1-claude-md-warning-flag-missing: the per-project trust block must carry all
// four keys, including hasClaudeMdExternalIncludesWarningShown (Python
// _seed_agent_config_dir 1418-1423).
test('provision writes all four trust keys including the external-includes warning flag', () => {
  const { home, cleanup } = makeTempHome();
  const skelRoot = join(home.workdir, '..', 'skel');
  mkdirSync(skelRoot, { recursive: true });
  seedSkeleton(skelRoot, {});
  try {
    withEnv({ ANTHROPIC_API_KEY: API_KEY }, () => {
      const agent = resolveAgent(claudeConfig());
      agent.provision({ ...home, skeletonRoot: skelRoot }, undefined as never);

      const claudeJson: { projects: Record<string, unknown> } = JSON.parse(
        readFileSync(join(home.configDir, '.claude.json'), 'utf8'),
      );
      const projectKeys = Object.keys(claudeJson.projects);
      expect(projectKeys.length).toBe(1);
      const firstKey = projectKeys[0] ?? '';
      expect(claudeJson.projects[firstKey]).toEqual({
        hasTrustDialogAccepted: true,
        projectOnboardingSeenCount: 1,
        hasClaudeMdExternalIncludesApproved: true,
        hasClaudeMdExternalIncludesWarningShown: true,
      });
    });
  } finally {
    cleanup();
  }
});

// B1-claude-trust-block-unconditional: with no skeleton seeded, Python skips the
// trust block entirely (guard `seeded` at 1415). The TS must not synthesize a
// .claude.json projects block from {} when no skeleton existed.
test('provision does not write a trust block when no skeleton was seeded', () => {
  const { home, cleanup } = makeTempHome();
  try {
    withEnv({ ANTHROPIC_API_KEY: API_KEY }, () => {
      const agent = resolveAgent(claudeConfig());
      // skeletonRoot undefined -> no skeleton copied.
      agent.provision(home, undefined as never);

      const claudeJsonPath = join(home.configDir, '.claude.json');
      // The approval step still writes .claude.json (it creates it from {}),
      // but it must not carry a per-project trust block.
      if (existsSync(claudeJsonPath)) {
        const claudeJson: { projects?: Record<string, unknown> } = JSON.parse(
          readFileSync(claudeJsonPath, 'utf8'),
        );
        expect(claudeJson.projects ?? {}).toEqual({});
      }
    });
  } finally {
    cleanup();
  }
});

// B1-claude-api-key-approval: when ANTHROPIC_API_KEY is in required_env, write
// the per-run approval fingerprint (api_key[-20:]) into
// customApiKeyResponses.approved and scrub it from rejected (Python
// _approve_claude_api_key 466-483).
test('provision seeds the customApiKeyResponses approval fingerprint and scrubs rejected', () => {
  const { home, cleanup } = makeTempHome();
  const skelRoot = join(home.workdir, '..', 'skel');
  mkdirSync(skelRoot, { recursive: true });
  // Skeleton pre-rejected this exact fingerprint; approval must move it.
  const fingerprint = API_KEY.slice(-20);
  seedSkeleton(skelRoot, {
    customApiKeyResponses: { approved: [], rejected: [fingerprint, 'other'] },
  });
  try {
    withEnv({ ANTHROPIC_API_KEY: API_KEY }, () => {
      const agent = resolveAgent(claudeConfig());
      agent.provision({ ...home, skeletonRoot: skelRoot }, undefined as never);

      const claudeJson: {
        customApiKeyResponses: { approved: string[]; rejected: string[] };
      } = JSON.parse(
        readFileSync(join(home.configDir, '.claude.json'), 'utf8'),
      );
      expect(claudeJson.customApiKeyResponses.approved).toEqual([fingerprint]);
      // The matching fingerprint is removed from rejected; others stay.
      expect(claudeJson.customApiKeyResponses.rejected).toEqual(['other']);
    });
  } finally {
    cleanup();
  }
});

// B1-claude-api-key-approval (idempotence): a fingerprint already approved is
// not duplicated (Python `if fingerprint not in approved`).
test('provision does not duplicate an already-approved fingerprint', () => {
  const { home, cleanup } = makeTempHome();
  const skelRoot = join(home.workdir, '..', 'skel');
  mkdirSync(skelRoot, { recursive: true });
  const fingerprint = API_KEY.slice(-20);
  seedSkeleton(skelRoot, {
    customApiKeyResponses: { approved: [fingerprint] },
  });
  try {
    withEnv({ ANTHROPIC_API_KEY: API_KEY }, () => {
      const agent = resolveAgent(claudeConfig());
      agent.provision({ ...home, skeletonRoot: skelRoot }, undefined as never);
      const claudeJson: {
        customApiKeyResponses: { approved: string[] };
      } = JSON.parse(
        readFileSync(join(home.configDir, '.claude.json'), 'utf8'),
      );
      expect(claudeJson.customApiKeyResponses.approved).toEqual([fingerprint]);
    });
  } finally {
    cleanup();
  }
});

// B1-x-claude-envfile-chmod-reenforce: the .claude-env mode must be 0600 even
// when the file already existed with looser perms (Python double-fchmods;
// writeFileSync's mode is ignored for an existing file, so a follow-up chmod is
// required).
test('provision re-enforces 0600 on a pre-existing looser-perm .claude-env', () => {
  const { home, cleanup } = makeTempHome();
  try {
    withEnv({ ANTHROPIC_API_KEY: API_KEY }, () => {
      // Pre-create configDir and a world-readable .claude-env.
      mkdirSync(home.configDir, { recursive: true });
      const envFile = join(home.configDir, '.claude-env');
      writeFileSync(envFile, 'STALE\n', { mode: 0o644 });
      expect(statSync(envFile).mode & 0o777).toBe(0o644);

      const agent = resolveAgent(claudeConfig());
      agent.provision(home, undefined as never);

      expect(readFileSync(envFile, 'utf8')).toBe(
        `ANTHROPIC_API_KEY='${API_KEY}'\n`,
      );
      expect(statSync(envFile).mode & 0o777).toBe(0o600);
    });
  } finally {
    cleanup();
  }
});

// B1-claude-api-key-approval (gating): when ANTHROPIC_API_KEY is NOT in
// required_env, the adapter must not write a .claude-env or approval block
// (Python gates both on `ANTHROPIC_API_KEY in required_env`).
test('provision skips env-file and approval when ANTHROPIC_API_KEY is not required', () => {
  const { home, cleanup } = makeTempHome();
  try {
    withEnv({ ANTHROPIC_API_KEY: API_KEY }, () => {
      const agent = resolveAgent(
        claudeConfig({ required_env: ['SUPERPOWERS_ROOT'] }),
      );
      agent.provision(home, undefined as never);
      expect(existsSync(join(home.configDir, '.claude-env'))).toBe(false);
      const claudeJsonPath = join(home.configDir, '.claude.json');
      if (existsSync(claudeJsonPath)) {
        const claudeJson: { customApiKeyResponses?: unknown } = JSON.parse(
          readFileSync(claudeJsonPath, 'utf8'),
        );
        expect(claudeJson.customApiKeyResponses).toBeUndefined();
      }
    });
  } finally {
    cleanup();
  }
});
