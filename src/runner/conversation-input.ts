import { quorumModeFromStory, StoryMetaError } from '../story-meta.ts';

const FRONTMATTER = /^(---\n[\s\S]*?\n---\n)/;
const ACCEPTANCE_CRITERIA = /^## Acceptance Criteria\s*$/m;
const ASSESSMENT_DESCRIPTION =
  'Assess the completed conversation using the acceptance criteria and retained evidence below.';

/** Give the conversation and assessment roles only the story text each needs. */
export function projectConversationStory(story: string): {
  brief: string;
  rubric: string;
} {
  if (quorumModeFromStory(story) !== 'conversation') {
    throw new StoryMetaError('conversation projection requires quorum_mode');
  }
  const frontmatter = story.match(FRONTMATTER)?.[1];
  if (frontmatter === undefined) {
    throw new StoryMetaError('conversation story frontmatter is missing');
  }

  const body = story.slice(frontmatter.length);
  const marker = ACCEPTANCE_CRITERIA.exec(body);
  if (marker === null) {
    throw new StoryMetaError(
      "conversation story missing '## Acceptance Criteria' section",
    );
  }
  const brief = body.slice(0, marker.index).trim();
  if (brief.length === 0) {
    throw new StoryMetaError('conversation user brief is empty');
  }

  const criteria = body.slice(marker.index).trim();
  const criteriaBody = criteria.slice(marker[0].length).trim();
  if (criteriaBody.length === 0) {
    throw new StoryMetaError('conversation acceptance criteria are empty');
  }

  return {
    brief: `${brief}\n`,
    rubric: `${frontmatter}\n${ASSESSMENT_DESCRIPTION}\n\n${criteria}\n`,
  };
}
