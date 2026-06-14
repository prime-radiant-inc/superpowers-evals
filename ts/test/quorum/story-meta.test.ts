import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  StoryMetaError,
  readQuorumMaxTime,
  readQuorumTier,
  readStoryStatus,
} from "../../src/quorum/story-meta.ts";

// Helper: create a temp dir, write story.md, return path to story.md
function storyPath(dir: string, body: string): string {
  const p = path.join(dir, "story.md");
  fs.writeFileSync(p, body, "utf-8");
  return p;
}

const FM =
  "---\nid: x\ntitle: y\ntags: sdd\n{extra}---\n\nBody text.\n";

function fm(extra: string): string {
  return FM.replace("{extra}", extra);
}

function simpleStory(dir: string, frontmatter: string): string {
  return storyPath(dir, `---\n${frontmatter}\n---\n\nbody\n`);
}

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "story-meta-test-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// --- readQuorumMaxTime ---

test("no_frontmatter_returns_undefined", () => {
  const p = storyPath(tmpDir, "No frontmatter here, just body.\n");
  expect(readQuorumMaxTime(p)).toBeUndefined();
});

test("frontmatter_without_key_returns_undefined", () => {
  const p = storyPath(tmpDir, fm(""));
  expect(readQuorumMaxTime(p)).toBeUndefined();
});

test("minutes_value", () => {
  const p = storyPath(tmpDir, fm("quorum_max_time: 90m\n"));
  expect(readQuorumMaxTime(p)).toBe("90m");
});

test("seconds_value", () => {
  const p = storyPath(tmpDir, fm("quorum_max_time: 600s\n"));
  expect(readQuorumMaxTime(p)).toBe("600s");
});

test("bare_seconds_value", () => {
  const p = storyPath(tmpDir, fm("quorum_max_time: 1800\n"));
  expect(readQuorumMaxTime(p)).toBe("1800");
});

test("quoted_value_is_stripped", () => {
  const p = storyPath(tmpDir, fm('quorum_max_time: "45m"\n'));
  expect(readQuorumMaxTime(p)).toBe("45m");
});

test("malformed_value_raises", () => {
  const p = storyPath(tmpDir, fm("quorum_max_time: ninety\n"));
  expect(() => readQuorumMaxTime(p)).toThrow(StoryMetaError);
});

// --- readQuorumTier ---

test("tier_defaults_to_full", () => {
  expect(readQuorumTier(simpleStory(tmpDir, "id: x"))).toBe("full");
});

test("tier_read_and_validated_sentinel", () => {
  // Use separate tmp subdirs since simpleStory writes to a fixed filename
  const d1 = fs.mkdtempSync(path.join(os.tmpdir(), "tier-"));
  const d2 = fs.mkdtempSync(path.join(os.tmpdir(), "tier-"));
  try {
    expect(readQuorumTier(simpleStory(d1, "quorum_tier: sentinel"))).toBe("sentinel");
    expect(readQuorumTier(simpleStory(d2, "quorum_tier: adhoc"))).toBe("adhoc");
  } finally {
    fs.rmSync(d1, { recursive: true, force: true });
    fs.rmSync(d2, { recursive: true, force: true });
  }
});

test("tier_invalid_raises", () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "tier-"));
  try {
    expect(() => readQuorumTier(simpleStory(d, "quorum_tier: turbo"))).toThrow(StoryMetaError);
  } finally {
    fs.rmSync(d, { recursive: true, force: true });
  }
});

// --- readStoryStatus ---

test("status_defaults_to_ready_and_reads", () => {
  const d1 = fs.mkdtempSync(path.join(os.tmpdir(), "status-"));
  const d2 = fs.mkdtempSync(path.join(os.tmpdir(), "status-"));
  try {
    expect(readStoryStatus(simpleStory(d1, "id: x"))).toBe("ready");
    expect(readStoryStatus(simpleStory(d2, "status: draft"))).toBe("draft");
  } finally {
    fs.rmSync(d1, { recursive: true, force: true });
    fs.rmSync(d2, { recursive: true, force: true });
  }
});

test("no_frontmatter_is_defaults", () => {
  const p = storyPath(tmpDir, "no frontmatter here\n");
  expect(readQuorumTier(p)).toBe("full");
  expect(readStoryStatus(p)).toBe("ready");
});
