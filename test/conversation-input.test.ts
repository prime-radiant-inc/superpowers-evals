import { expect, test } from 'bun:test';
import { projectConversationStory } from '../src/runner/conversation-input.ts';
import { StoryMetaError } from '../src/story-meta.ts';

const STORY =
  '---\nid: p\ntitle: Pricing\nquorum_mode: conversation\n---\n' +
  'PRIVATE_USER_FACT\n\n## Acceptance Criteria\n- PRIVATE_GRADE_RULE\n';

test('conversation projection gives each role only its own story content', () => {
  const projected = projectConversationStory(STORY);
  expect(projected.brief).toContain('PRIVATE_USER_FACT');
  expect(projected.brief).not.toContain('PRIVATE_GRADE_RULE');
  expect(projected.brief).not.toContain('quorum_mode: conversation');
  expect(projected.rubric).toContain('PRIVATE_GRADE_RULE');
  expect(projected.rubric).not.toContain('PRIVATE_USER_FACT');
  expect(projected.rubric).toStartWith(
    '---\nid: p\ntitle: Pricing\nquorum_mode: conversation\n---\n',
  );
});

test('conversation projection rejects empty role inputs', () => {
  expect(() =>
    projectConversationStory(
      '---\nid: p\nquorum_mode: conversation\n---\n\n## Acceptance Criteria\n- rule\n',
    ),
  ).toThrow(StoryMetaError);
  expect(() =>
    projectConversationStory(
      '---\nid: p\nquorum_mode: conversation\n---\nuser brief\n',
    ),
  ).toThrow(StoryMetaError);
  expect(() =>
    projectConversationStory(
      '---\nid: p\nquorum_mode: conversation\n---\nuser brief\n\n## Acceptance Criteria\n\n',
    ),
  ).toThrow(StoryMetaError);
});

test('conversation projection refuses qa and unknown modes', () => {
  expect(() =>
    projectConversationStory(STORY.replace('conversation', 'qa')),
  ).toThrow(StoryMetaError);
  expect(() =>
    projectConversationStory(STORY.replace('conversation', 'unknown')),
  ).toThrow(StoryMetaError);
});
