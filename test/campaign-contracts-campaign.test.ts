// test/campaign-contracts-campaign.test.ts
import { expect, test } from 'bun:test';
import {
  CampaignIdentitySchema,
  ExecutionSurfaceArmSchema,
  ID_COMPONENT_RE,
} from '../src/contracts/campaign/campaign.ts';

test('ID_COMPONENT_RE: the pinned grammar, delimiter-exclusion included', () => {
  expect(ID_COMPONENT_RE.test('a')).toBe(true);
  expect(ID_COMPONENT_RE.test('scenario-01.x_y')).toBe(true);
  expect(ID_COMPONENT_RE.test('has:colon')).toBe(false);
  expect(ID_COMPONENT_RE.test('Upper')).toBe(false);
  expect(ID_COMPONENT_RE.test('-leading-dash')).toBe(false);
  expect(ID_COMPONENT_RE.test('.dot-first')).toBe(false);
});

test('CampaignIdentitySchema is strict; execution_surface takes env-var NAMES only', () => {
  expect(() =>
    CampaignIdentitySchema.parse({
      campaign_id: 'c',
      comparison_id: 'cmp',
      block_id: 'b',
      sample_id: 's',
      execution_attempt_id: 's:a1',
    }),
  ).not.toThrow();
  expect(() =>
    CampaignIdentitySchema.parse({
      campaign_id: 'c',
      comparison_id: 'cmp',
      block_id: 'b',
      sample_id: 's',
    }),
  ).toThrow();
  const arm = {
    name: 'base_arm',
    agent: 'claude',
    credential: 'opus_fx',
    auth: 'api-key',
    api: 'anthropic',
    model: 'claude-opus-5',
    key_env_names: ['ANTHROPIC_API_KEY'],
  };
  expect(() => ExecutionSurfaceArmSchema.parse(arm)).not.toThrow();
  // Secret-shaped strings reject where env-var names belong (Blocker C: the
  // surface is scrubbed — names only, never key material).
  expect(() =>
    ExecutionSurfaceArmSchema.parse({
      ...arm,
      key_env_names: ['sk-ant-this-is-a-secret'],
    }),
  ).toThrow();
});
