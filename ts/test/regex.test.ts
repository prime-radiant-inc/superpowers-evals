// Tests for posixToJsRegex — POSIX bracket expression translation.

import { test, expect } from "bun:test";
import { posixToJsRegex } from "../src/check/regex.ts";
import { verbToolMatchBeforeToolMatch } from "../src/check/verbs.ts";
import type { ToolCallView } from "../src/atif/project.ts";

// ---------------------------------------------------------------------------
// posixToJsRegex unit tests
// ---------------------------------------------------------------------------

test("posixToJsRegex: [[:space:]]+ matches single space", () => {
  expect(posixToJsRegex("git[[:space:]]+commit").test("git commit")).toBe(true);
});

test("posixToJsRegex: [[:space:]]+ matches multiple spaces", () => {
  expect(posixToJsRegex("git[[:space:]]+commit").test("git    commit")).toBe(true);
});

test("posixToJsRegex: [[:space:]]+ does not match gitcommit", () => {
  expect(posixToJsRegex("git[[:space:]]+commit").test("gitcommit")).toBe(false);
});

test("posixToJsRegex: [[:space:]]+ matches tab", () => {
  expect(posixToJsRegex("git[[:space:]]+commit").test("git\tcommit")).toBe(true);
});

test("posixToJsRegex: [^[:alnum:]_] in word-boundary pattern matches non-word char", () => {
  expect(
    posixToJsRegex("(^|[^[:alnum:]_])(grep)([^[:alnum:]_]|$)").test("grep foo"),
  ).toBe(true);
});

test("posixToJsRegex: [^[:alnum:]_] does not match mid-word grep", () => {
  expect(
    posixToJsRegex("(^|[^[:alnum:]_])(grep)([^[:alnum:]_]|$)").test("agreping"),
  ).toBe(false);
});

test("posixToJsRegex: [:alpha:] matches letters", () => {
  expect(posixToJsRegex("[[:alpha:]]+").test("hello")).toBe(true);
  expect(posixToJsRegex("[[:alpha:]]+").test("123")).toBe(false);
});

test("posixToJsRegex: [:digit:] matches digits", () => {
  expect(posixToJsRegex("[[:digit:]]+").test("42")).toBe(true);
  expect(posixToJsRegex("[[:digit:]]+").test("abc")).toBe(false);
});

test("posixToJsRegex: [:upper:] matches uppercase", () => {
  expect(posixToJsRegex("[[:upper:]]").test("A")).toBe(true);
  expect(posixToJsRegex("[[:upper:]]").test("a")).toBe(false);
});

test("posixToJsRegex: [:lower:] matches lowercase", () => {
  expect(posixToJsRegex("[[:lower:]]").test("a")).toBe(true);
  expect(posixToJsRegex("[[:lower:]]").test("A")).toBe(false);
});

test("posixToJsRegex: [:blank:] matches space and tab", () => {
  expect(posixToJsRegex("[[:blank:]]").test(" ")).toBe(true);
  expect(posixToJsRegex("[[:blank:]]").test("\t")).toBe(true);
  expect(posixToJsRegex("[[:blank:]]").test("a")).toBe(false);
});

test("posixToJsRegex: [:xdigit:] matches hex digits", () => {
  expect(posixToJsRegex("[[:xdigit:]]+").test("deadbeef")).toBe(true);
  expect(posixToJsRegex("[[:xdigit:]]+").test("CAFE12")).toBe(true);
  expect(posixToJsRegex("[[:xdigit:]]+").test("xyz")).toBe(false);
});

test("posixToJsRegex: plain regex unchanged", () => {
  expect(posixToJsRegex("pytest").test("pytest tests/")).toBe(true);
  expect(posixToJsRegex("pytest").test("nope")).toBe(false);
});

// ---------------------------------------------------------------------------
// Regression test: tool-match-before-tool-match with POSIX classes
// This is the verdict-flipping bug from verification-phantom-completion.
// ---------------------------------------------------------------------------

function call(tool: string, args: Record<string, unknown> = {}): ToolCallView {
  return { tool, args };
}

test("tool-match-before-tool-match: POSIX [[:space:]]+ — pytest before git commit PASSES", () => {
  const result = verbToolMatchBeforeToolMatch(
    [
      call("Bash", { command: "pytest" }),
      call("Bash", { command: "git commit -m x" }),
    ],
    false,
    ["Bash", "pytest", "Bash", "git[[:space:]]+commit"],
  );
  expect(result.passed).toBe(true);
  expect(result.detail).toContain("before");
});

test("tool-match-before-tool-match: POSIX [[:space:]]+ — git commit before pytest FAILS (not vacuous)", () => {
  // This is the key regression: before the fix, `git[[:space:]]+commit` silently
  // failed to match because JS RegExp doesn't understand [:space:], so the check
  // vacuously PASSED when it should have FAILED.
  const result = verbToolMatchBeforeToolMatch(
    [
      call("Bash", { command: "git commit -m x" }),
      call("Bash", { command: "pytest" }),
    ],
    false,
    ["Bash", "pytest", "Bash", "git[[:space:]]+commit"],
  );
  expect(result.passed).toBe(false);
  // Must NOT be vacuous — the git commit DID match
  expect(result.detail).not.toContain("vacuous");
  expect(result.detail).toContain("fired after");
});
