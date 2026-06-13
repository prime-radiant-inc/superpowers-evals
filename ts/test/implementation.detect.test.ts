import { test, expect } from "bun:test";
import { toolPath, implementationRelpath, isImplementationPath } from "../src/detect/implementation.ts";
import type { ToolCallView } from "../src/atif/project.ts";

function call(tool: string, args: Record<string, unknown>): ToolCallView {
  return { tool, args };
}

// --- isImplementationPath / implementationRelpath ---

test("Write under coding-agent-workdir → isImplementationPath true, relpath correct", () => {
  const c = call("Write", { file_path: "/run/coding-agent-workdir/src/auth.js" });
  expect(implementationRelpath(c)).toBe("src/auth.js");
  expect(isImplementationPath(c)).toBe(true);
});

test("Write coding-agent-workdir/.gitignore → false (excluded)", () => {
  const c = call("Write", { file_path: "/run/coding-agent-workdir/.gitignore" });
  expect(isImplementationPath(c)).toBe(false);
});

test("Write coding-agent-workdir/docs/superpowers/ → false (excluded)", () => {
  const c = call("Write", {
    file_path: "/run/coding-agent-workdir/docs/superpowers/specs/x.md",
  });
  expect(isImplementationPath(c)).toBe(false);
});

test("Write coding-agent-workdir/.git/config → false (excluded)", () => {
  const c = call("Write", { file_path: "/run/coding-agent-workdir/.git/config" });
  expect(isImplementationPath(c)).toBe(false);
});

test("Read absolute path not under workdir → false (relpath empty)", () => {
  const c = call("Read", { file_path: "/tmp/run/skills/foo/SKILL.md" });
  expect(implementationRelpath(c)).toBe("");
  expect(isImplementationPath(c)).toBe(false);
});

test("Write relative path → true, relpath preserved", () => {
  const c = call("Write", { file_path: "src/app.py" });
  expect(implementationRelpath(c)).toBe("src/app.py");
  expect(isImplementationPath(c)).toBe(true);
});

test("Write with no path args → false (empty path)", () => {
  const c = call("Write", {});
  expect(toolPath(c)).toBe("");
  expect(implementationRelpath(c)).toBe("");
  expect(isImplementationPath(c)).toBe(false);
});

// --- toolPath field priority ---

test("toolPath picks file_path first", () => {
  const c = call("Write", { file_path: "/a/b.ts", path: "/c/d.ts" });
  expect(toolPath(c)).toBe("/a/b.ts");
});

test("toolPath falls back to path when file_path absent", () => {
  const c = call("Read", { path: "/c/d.ts" });
  expect(toolPath(c)).toBe("/c/d.ts");
});

test("toolPath picks TargetFile when earlier fields absent", () => {
  const c = call("ApplyPatch", { TargetFile: "/x/y.go" });
  expect(toolPath(c)).toBe("/x/y.go");
});

test("toolPath picks target_file", () => {
  expect(toolPath(call("X", { target_file: "/a.py" }))).toBe("/a.py");
});

test("toolPath picks filePath", () => {
  expect(toolPath(call("X", { filePath: "/a.py" }))).toBe("/a.py");
});

test("toolPath picks AbsolutePath", () => {
  expect(toolPath(call("X", { AbsolutePath: "/a.py" }))).toBe("/a.py");
});

test("toolPath picks Path", () => {
  expect(toolPath(call("X", { Path: "/a.py" }))).toBe("/a.py");
});

test("toolPath picks TargetPath", () => {
  expect(toolPath(call("X", { TargetPath: "/a.py" }))).toBe("/a.py");
});

// --- canonical_string: JSON-encoded string value is unwrapped ---

test("toolPath unwraps JSON-encoded string path", () => {
  // Some agents emit file_path as a JSON-encoded string: '"/actual/path.ts"'
  const c = call("Write", { file_path: '"/actual/path.ts"' });
  expect(toolPath(c)).toBe("/actual/path.ts");
});

test("toolPath uses raw string when JSON parse fails", () => {
  const c = call("Write", { file_path: "not json at all" });
  expect(toolPath(c)).toBe("not json at all");
});

// --- node_modules exclusion ---

test("Write to node_modules path → false", () => {
  const c = call("Write", { file_path: "/run/coding-agent-workdir/node_modules/foo/index.js" });
  expect(isImplementationPath(c)).toBe(false);
});

// --- .antigravitycli exclusion ---

test("Write to .antigravitycli path → false", () => {
  const c = call("Write", { file_path: "/run/coding-agent-workdir/.antigravitycli/config" });
  expect(isImplementationPath(c)).toBe(false);
});

// --- workdir split takes LAST segment (jq `split | last` behavior) ---

test("path with two coding-agent-workdir segments → relpath is after last one", () => {
  const c = call("Write", {
    file_path: "/run/coding-agent-workdir/nested/coding-agent-workdir/src/x.ts",
  });
  expect(implementationRelpath(c)).toBe("src/x.ts");
});
