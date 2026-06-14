import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import {
  ScaffoldError,
  newScenario,
  checkScenario,
  fixExecutableBits,
} from "../../src/quorum/scaffold.ts";

// ---- helpers ----

function makeTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "scaffold-test-"));
}

function rmrf(p: string): void {
  fs.rmSync(p, { recursive: true, force: true });
}

/** Build a minimal valid scenario dir without using newScenario */
function makeManualScenario(
  d: string,
  opts: { withChecks?: boolean; body?: string } = {},
): string {
  const { withChecks = true, body } = opts;
  fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(
    path.join(d, "story.md"),
    "---\nid: x\ntitle: t\n---\n## Acceptance Criteria\n- a\n",
  );
  fs.writeFileSync(path.join(d, "setup.sh"), "#!/usr/bin/env bash\n:\n");
  fs.chmodSync(path.join(d, "setup.sh"), 0o755);
  if (withChecks) {
    fs.writeFileSync(
      path.join(d, "checks.sh"),
      body ?? "pre() { :; }\npost() { :; }\n",
    );
  }
  return d;
}

// ---- TestNewScenario ----

describe("TestNewScenario", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = makeTmpDir();
  });
  afterEach(() => {
    rmrf(tmp);
  });

  test("creates skeleton that passes check", () => {
    const scenarioDir = newScenario(tmp, "demo");
    expect(scenarioDir).toBe(path.join(tmp, "demo"));
    expect(fs.existsSync(path.join(scenarioDir, "story.md"))).toBe(true);
    expect(fs.existsSync(path.join(scenarioDir, "checks.sh"))).toBe(true);
    // setup.sh is executable
    const setupMode = fs.statSync(path.join(scenarioDir, "setup.sh")).mode;
    expect(setupMode & 0o111).not.toBe(0);
    // checks.sh must exist (executable bit not required to be set)
    expect(fs.existsSync(path.join(scenarioDir, "checks.sh"))).toBe(true);
    // A freshly scaffolded scenario is structurally valid
    expect(checkScenario(scenarioDir)).toEqual([]);
  });

  test("story frontmatter carries the name", () => {
    const scenarioDir = newScenario(tmp, "my-scenario");
    const text = fs.readFileSync(path.join(scenarioDir, "story.md"), "utf8");
    expect(text).toContain("id: my-scenario");
  });

  test("refuses to clobber existing", () => {
    newScenario(tmp, "demo");
    expect(() => newScenario(tmp, "demo")).toThrow(ScaffoldError);
    expect(() => newScenario(tmp, "demo")).toThrow(/already exists/);
  });

  test("no assertions dir created", () => {
    const scenarioDir = newScenario(tmp, "demo");
    expect(fs.existsSync(path.join(scenarioDir, "assertions"))).toBe(false);
  });

  test("no preflight.sh created", () => {
    const scenarioDir = newScenario(tmp, "demo");
    expect(fs.existsSync(path.join(scenarioDir, "preflight.sh"))).toBe(false);
  });
});

// ---- TestCheckScenario ----

describe("TestCheckScenario", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = makeTmpDir();
  });
  afterEach(() => {
    rmrf(tmp);
  });

  function valid(): string {
    return newScenario(tmp, "demo");
  }

  test("non-executable setup is caught", () => {
    const sd = valid();
    fs.chmodSync(path.join(sd, "setup.sh"), 0o600);
    const problems = checkScenario(sd);
    expect(problems.some((p) => p.includes("setup.sh is not executable"))).toBe(true);
  });

  test("missing story is caught", () => {
    const sd = valid();
    fs.rmSync(path.join(sd, "story.md"));
    const problems = checkScenario(sd);
    expect(problems.some((p) => p.includes("story.md missing"))).toBe(true);
  });

  test("missing acceptance criteria is caught", () => {
    const sd = valid();
    fs.writeFileSync(path.join(sd, "story.md"), "---\nid: demo\ntitle: x\n---\nbody\n");
    const problems = checkScenario(sd);
    expect(problems.some((p) => p.includes("Acceptance Criteria"))).toBe(true);
  });

  test("missing frontmatter key is caught", () => {
    const sd = valid();
    fs.writeFileSync(
      path.join(sd, "story.md"),
      "---\nid: demo\n---\n## Acceptance Criteria\n- x\n",
    );
    const problems = checkScenario(sd);
    expect(problems.some((p) => p.includes("missing 'title'"))).toBe(true);
  });

  test("unknown setup helper is caught", () => {
    const sd = valid();
    fs.writeFileSync(
      path.join(sd, "setup.sh"),
      "#!/usr/bin/env bash\nset -euo pipefail\nsetup-helpers run no_such_helper\n",
    );
    const problems = checkScenario(sd);
    expect(problems.some((p) => p.includes("unknown helper 'no_such_helper'"))).toBe(true);
  });

  test("scenario.yaml is ignored by check", () => {
    const sd = valid();
    fs.writeFileSync(path.join(sd, "scenario.yaml"), "compatible_targets: not-a-list\n");
    const problems = checkScenario(sd);
    expect(problems.some((p) => p.includes("scenario.yaml invalid"))).toBe(false);
  });

  function storyWithTier(tierLine: string): string {
    const sd = valid();
    const storyPath = path.join(sd, "story.md");
    let text = fs.readFileSync(storyPath, "utf8");
    text = text.replace("quorum_tier: full\n", `${tierLine}\n`);
    fs.writeFileSync(storyPath, text);
    return sd;
  }

  test("valid tier sentinel is accepted", () => {
    const sd = storyWithTier("quorum_tier: sentinel");
    expect(checkScenario(sd)).toEqual([]);
  });

  test("valid tier full is accepted", () => {
    const sd = storyWithTier("quorum_tier: full");
    expect(checkScenario(sd)).toEqual([]);
  });

  test("valid tier adhoc is accepted", () => {
    const sd = storyWithTier("quorum_tier: adhoc");
    expect(checkScenario(sd)).toEqual([]);
  });

  test("absent tier is accepted", () => {
    const sd = valid();
    const storyPath = path.join(sd, "story.md");
    let text = fs.readFileSync(storyPath, "utf8");
    text = text.replace("quorum_tier: full\n", "");
    fs.writeFileSync(storyPath, text);
    expect(checkScenario(sd)).toEqual([]);
  });

  test("invalid tier is caught", () => {
    const sd = storyWithTier("quorum_tier: bogus");
    const problems = checkScenario(sd);
    expect(problems.some((p) => p.includes("quorum_tier"))).toBe(true);
  });
});

// ---- TestScaffoldTemplate ----

describe("TestScaffoldTemplate", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = makeTmpDir();
  });
  afterEach(() => {
    rmrf(tmp);
  });

  test("template contains quorum_tier full", () => {
    const scenarioDir = newScenario(tmp, "demo");
    const text = fs.readFileSync(path.join(scenarioDir, "story.md"), "utf8");
    expect(text).toContain("quorum_tier: full");
  });
});

// ---- TestChecksShValidation ----

describe("TestChecksShValidation", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = makeTmpDir();
  });
  afterEach(() => {
    rmrf(tmp);
  });

  test("check_scenario valid", () => {
    const s = makeManualScenario(path.join(tmp, "s"));
    expect(checkScenario(s)).toEqual([]);
  });

  test("check_scenario missing checks", () => {
    const s = makeManualScenario(path.join(tmp, "s"), { withChecks: false });
    const problems = checkScenario(s);
    expect(problems.some((p) => p.includes("checks.sh"))).toBe(true);
  });

  test("check_scenario rejects top-level statements", () => {
    const s = makeManualScenario(path.join(tmp, "s"), {
      body: "echo hi\npre() { :; }\npost() { :; }\n",
    });
    const problems = checkScenario(s);
    expect(problems.some((p) => p.includes("functions-only"))).toBe(true);
  });

  test("check_scenario requires both functions", () => {
    const s = makeManualScenario(path.join(tmp, "s"), { body: "pre() { :; }\n" });
    const problems = checkScenario(s);
    expect(problems.some((p) => p.includes("post"))).toBe(true);
  });

  test("check_scenario accepts coding-agents comment", () => {
    const body = "# coding-agents: codex\npre() { :; }\npost() { :; }\n";
    const s = makeManualScenario(path.join(tmp, "s"), { body });
    expect(checkScenario(s)).toEqual([]);
  });

  test("check_scenario accepts continuation amp (&&)", () => {
    const body =
      "pre() {\n    git-repo &&\n        git-branch main\n}\npost() { :; }\n";
    const s = makeManualScenario(path.join(tmp, "s"), { body });
    const problems = checkScenario(s);
    expect(problems.some((p) => p.includes("backgrounded"))).toBe(false);
  });

  test("check_scenario flags single amp", () => {
    const body = "pre() { :; }\npost() {\n    file-exists '*.md' &\n}\n";
    const s = makeManualScenario(path.join(tmp, "s"), { body });
    const problems = checkScenario(s);
    expect(problems.some((p) => p.includes("backgrounded"))).toBe(true);
  });

  test("check_scenario flags harness workdir ref", () => {
    const body =
      'pre() {\n    command-succeeds \'grep -q foo "$QUORUM_WORKDIR/x"\'\n}\npost() { :; }\n';
    const s = makeManualScenario(path.join(tmp, "s"), { body });
    const problems = checkScenario(s);
    expect(problems.some((p) => p.includes("QUORUM_WORKDIR"))).toBe(true);
  });

  test("check_scenario flags harness workdir braced form", () => {
    const body =
      'pre() {\n    command-succeeds \'grep -q foo "${QUORUM_WORKDIR}/x"\'\n}\npost() { :; }\n';
    const s = makeManualScenario(path.join(tmp, "s"), { body });
    const problems = checkScenario(s);
    expect(problems.some((p) => p.includes("QUORUM_WORKDIR"))).toBe(true);
  });
});

// ---- TestFixExecutableBits ----

describe("TestFixExecutableBits", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = makeTmpDir();
  });
  afterEach(() => {
    rmrf(tmp);
  });

  test("fixes setup", () => {
    const sd = newScenario(tmp, "demo");
    fs.chmodSync(path.join(sd, "setup.sh"), 0o600);
    const fixed = fixExecutableBits(sd);
    expect(fixed.some((f) => f.includes("setup.sh"))).toBe(true);
    const mode = fs.statSync(path.join(sd, "setup.sh")).mode;
    expect(mode & 0o111).not.toBe(0);
  });

  test("no fix needed is noop", () => {
    const sd = newScenario(tmp, "demo");
    expect(fixExecutableBits(sd)).toEqual([]);
  });
});
