// Port of tests/quorum/test_coding_agent_config.py
import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { stringify as yamlStringify } from "yaml";
import {
  CodingAgentConfigError,
  defaultSuperpowersRoot,
  ensureSuperpowersRootDefault,
  loadCodingAgentConfig,
  SUPPORTED_NORMALIZERS,
  KNOWN_RUNTIME_FAMILIES,
  type CodingAgentConfig,
} from "../../src/quorum/coding-agent-config.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTmpDir(): string {
  return mkdtempSync(join(tmpdir(), "quorum-test-"));
}

function writeYaml(dir: string, name: string, doc: Record<string, unknown>): string {
  const p = join(dir, `${name}.yaml`);
  writeFileSync(p, yamlStringify(doc));
  return p;
}

// Snapshot and restore env vars that tests mutate.
let savedEnv: Record<string, string | undefined>;

beforeEach(() => {
  savedEnv = {
    SUPERPOWERS_ROOT: process.env["SUPERPOWERS_ROOT"],
    ANTHROPIC_API_KEY: process.env["ANTHROPIC_API_KEY"],
    GEMINI_API_KEY: process.env["GEMINI_API_KEY"],
    KIMI_MODEL_API_KEY: process.env["KIMI_MODEL_API_KEY"],
    PI_PROVIDER: process.env["PI_PROVIDER"],
    PI_MODEL: process.env["PI_MODEL"],
    PI_API_KEY: process.env["PI_API_KEY"],
  };
});

afterEach(() => {
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) {
      delete process.env[k];
    } else {
      process.env[k] = v;
    }
  }
});

// ---------------------------------------------------------------------------
// defaultSuperpowersRoot
// ---------------------------------------------------------------------------

test("defaultSuperpowersRoot detects nested evals checkout", () => {
  const tmp = makeTmpDir();
  try {
    const superpowers = join(tmp, "superpowers");
    const evals = join(superpowers, "evals");
    mkdirSync(join(superpowers, "skills"), { recursive: true });
    mkdirSync(evals, { recursive: true });

    expect(defaultSuperpowersRoot(evals)).toBe(resolve(superpowers));
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("defaultSuperpowersRoot ignores standalone checkout", () => {
  const tmp = makeTmpDir();
  try {
    const checkout = join(tmp, "superpowers-evals");
    mkdirSync(checkout);
    expect(defaultSuperpowersRoot(checkout)).toBeNull();
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// ensureSuperpowersRootDefault
// ---------------------------------------------------------------------------

test("ensureSuperpowersRootDefault respects existing value", () => {
  const tmp = makeTmpDir();
  try {
    const superpowers = join(tmp, "superpowers");
    const evals = join(superpowers, "evals");
    mkdirSync(join(superpowers, "skills"), { recursive: true });
    mkdirSync(evals, { recursive: true });
    process.env["SUPERPOWERS_ROOT"] = "/custom/superpowers";

    ensureSuperpowersRootDefault(evals);

    expect(process.env["SUPERPOWERS_ROOT"]).toBe("/custom/superpowers");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("ensureSuperpowersRootDefault sets value for nested checkout", () => {
  const tmp = makeTmpDir();
  try {
    const superpowers = join(tmp, "superpowers");
    const evals = join(superpowers, "evals");
    mkdirSync(join(superpowers, "skills"), { recursive: true });
    mkdirSync(evals, { recursive: true });
    delete process.env["SUPERPOWERS_ROOT"];

    ensureSuperpowersRootDefault(evals);

    expect(process.env["SUPERPOWERS_ROOT"]).toBe(resolve(superpowers));
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Real config parity checks (all 8 coding-agents/*.yaml)
// ---------------------------------------------------------------------------

const CODING_AGENTS_DIR = resolve(
  import.meta.dir,
  "../../..",
  "coding-agents",
);

test("antigravity.yaml loads correctly", () => {
  const tmp = makeTmpDir();
  try {
    process.env["SUPERPOWERS_ROOT"] = join(tmp, "superpowers");
    const cfg = loadCodingAgentConfig(join(CODING_AGENTS_DIR, "antigravity.yaml"));

    expect(cfg.name).toBe("antigravity");
    expect(cfg.binary).toBe("agy");
    expect(cfg.agentConfigEnv).toBe("ANTIGRAVITY_CONFIG_DIR");
    expect(cfg.normalizer).toBe("antigravity");
    // resolve_session_log_dir equivalent
    const cfgDir = join(tmp, "cfg");
    const resolved = cfg.resolveSessionLogDir(cfgDir);
    expect(resolved).toBe(resolve(cfgDir, ".gemini", "antigravity-cli", "brain"));
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("claude.yaml loads correctly", () => {
  const tmp = makeTmpDir();
  try {
    process.env["ANTHROPIC_API_KEY"] = "test-anthropic-key";
    process.env["SUPERPOWERS_ROOT"] = join(tmp, "superpowers");
    const cfg = loadCodingAgentConfig(join(CODING_AGENTS_DIR, "claude.yaml"));

    expect(cfg.name).toBe("claude");
    expect(cfg.runtimeFamily).toBe("claude");
    expect(cfg.model).toBe("opus");
    expect(cfg.projectPrompt).toBe(
      resolve(CODING_AGENTS_DIR, "claude.project-prompt.md"),
    );
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("claude-haiku.yaml loads correctly", () => {
  const tmp = makeTmpDir();
  try {
    process.env["ANTHROPIC_API_KEY"] = "test-anthropic-key";
    process.env["SUPERPOWERS_ROOT"] = join(tmp, "superpowers");
    const cfg = loadCodingAgentConfig(join(CODING_AGENTS_DIR, "claude-haiku.yaml"));

    expect(cfg.name).toBe("claude-haiku");
    expect(cfg.runtimeFamily).toBe("claude");
    expect(cfg.binary).toBe("claude");
    expect(cfg.agentConfigEnv).toBe("CLAUDE_CONFIG_DIR");
    expect(cfg.normalizer).toBe("claude");
    expect(cfg.model).toBe("claude-haiku-4-5-20251001");
    expect(cfg.projectPrompt).toBe(
      resolve(CODING_AGENTS_DIR, "claude.project-prompt.md"),
    );
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("gemini.yaml loads correctly", () => {
  const tmp = makeTmpDir();
  try {
    process.env["GEMINI_API_KEY"] = "test-gemini-key";
    process.env["SUPERPOWERS_ROOT"] = join(tmp, "superpowers");
    const cfg = loadCodingAgentConfig(join(CODING_AGENTS_DIR, "gemini.yaml"));

    expect(cfg.name).toBe("gemini");
    expect(cfg.binary).toBe("gemini");
    expect(cfg.agentConfigEnv).toBe("GEMINI_CLI_HOME");
    expect(cfg.normalizer).toBe("gemini");
    expect(cfg.sessionLogGlob).toBe("**/chats/**/*.json*");
    const cfgDir = join(tmp, "cfg");
    expect(cfg.resolveSessionLogDir(cfgDir)).toBe(
      resolve(cfgDir, ".gemini", "tmp"),
    );
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("opencode.yaml loads correctly", () => {
  const tmp = makeTmpDir();
  try {
    process.env["SUPERPOWERS_ROOT"] = join(tmp, "superpowers");
    const cfg = loadCodingAgentConfig(join(CODING_AGENTS_DIR, "opencode.yaml"));

    expect(cfg.name).toBe("opencode");
    expect(cfg.binary).toBe("opencode");
    expect(cfg.agentConfigEnv).toBe("OPENCODE_QUORUM_HOME");
    expect(cfg.sessionLogGlob).toBe("[0-9]*-ses_*.json");
    expect(cfg.normalizer).toBe("opencode");
    const cfgDir = join(tmp, "cfg");
    expect(cfg.resolveSessionLogDir(cfgDir)).toBe(
      resolve(cfgDir, ".quorum", "session-exports"),
    );
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("pi.yaml loads correctly", () => {
  const tmp = makeTmpDir();
  try {
    process.env["SUPERPOWERS_ROOT"] = join(tmp, "superpowers");
    process.env["PI_PROVIDER"] = "azure-openai-responses";
    process.env["PI_MODEL"] = "gpt-5.4";
    process.env["PI_API_KEY"] = "pi-test-key";
    const cfg = loadCodingAgentConfig(join(CODING_AGENTS_DIR, "pi.yaml"));

    expect(cfg.name).toBe("pi");
    expect(cfg.binary).toBe("pi");
    expect(cfg.agentConfigEnv).toBe("PI_CODING_AGENT_DIR");
    expect(cfg.normalizer).toBe("pi");
    expect(cfg.sessionLogGlob).toBe("*.jsonl");
    const cfgDir = join(tmp, "cfg");
    expect(cfg.resolveSessionLogDir(cfgDir)).toBe(resolve(cfgDir, "sessions"));
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("kimi.yaml loads correctly", () => {
  const tmp = makeTmpDir();
  try {
    process.env["SUPERPOWERS_ROOT"] = join(tmp, "superpowers");
    process.env["KIMI_MODEL_API_KEY"] = "fake-kimi-key";
    const cfg = loadCodingAgentConfig(join(CODING_AGENTS_DIR, "kimi.yaml"));

    expect(cfg.name).toBe("kimi");
    expect(cfg.binary).toBe("kimi");
    expect(cfg.agentConfigEnv).toBe("KIMI_CODE_HOME");
    expect(cfg.requiredEnv).toEqual(["SUPERPOWERS_ROOT", "KIMI_MODEL_API_KEY"]);
    expect(cfg.normalizer).toBe("kimi");
    const cfgDir = join(tmp, "cfg");
    expect(cfg.resolveSessionLogDir(cfgDir)).toBe(resolve(cfgDir, "sessions"));
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("kimi.yaml requires KIMI_MODEL_API_KEY", () => {
  const tmp = makeTmpDir();
  try {
    process.env["SUPERPOWERS_ROOT"] = join(tmp, "superpowers");
    delete process.env["KIMI_MODEL_API_KEY"];

    expect(() =>
      loadCodingAgentConfig(join(CODING_AGENTS_DIR, "kimi.yaml")),
    ).toThrow(/KIMI_MODEL_API_KEY/);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("copilot.yaml loads correctly", () => {
  const tmp = makeTmpDir();
  try {
    process.env["SUPERPOWERS_ROOT"] = join(tmp, "superpowers");
    const cfg = loadCodingAgentConfig(join(CODING_AGENTS_DIR, "copilot.yaml"));

    expect(cfg.name).toBe("copilot");
    expect(cfg.binary).toBe("copilot");
    expect(cfg.agentConfigEnv).toBe("COPILOT_HOME");
    expect(cfg.sessionLogGlob).toBe("**/events.jsonl");
    expect(cfg.normalizer).toBe("copilot");
    expect(cfg.requiredEnv).toEqual(["SUPERPOWERS_ROOT"]);
    expect(cfg.maxTime).toBe("10m");
    const cfgDir = join(tmp, "cfg");
    expect(cfg.resolveSessionLogDir(cfgDir)).toBe(
      resolve(cfgDir, "session-state"),
    );
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// TestLoadCodingAgentConfig — ported from Python TestLoadCodingAgentConfig
// ---------------------------------------------------------------------------

describe("loadCodingAgentConfig", () => {
  test("minimal valid config", () => {
    const tmp = makeTmpDir();
    try {
      process.env["ANTHROPIC_API_KEY"] = "x";
      const path = writeYaml(tmp, "claude", {
        name: "claude",
        binary: "claude",
        agent_config_env: "CLAUDE_CONFIG_DIR",
        session_log_dir: "${CLAUDE_CONFIG_DIR}/projects",
        session_log_glob: "**/session-*.jsonl",
        normalizer: "claude",
        required_env: ["ANTHROPIC_API_KEY"],
        model: "opus",
      });
      const cfg = loadCodingAgentConfig(path);
      expect(cfg.name).toBe("claude");
      expect(cfg.binary).toBe("claude");
      expect(cfg.agentConfigEnv).toBe("CLAUDE_CONFIG_DIR");
      expect(cfg.sessionLogDir).toBe("${CLAUDE_CONFIG_DIR}/projects");
      expect(cfg.normalizer).toBe("claude");
      expect(cfg.maxTime).toBeNull();
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("runtime_family defaults to name and model defaults to null", () => {
    const tmp = makeTmpDir();
    try {
      const path = writeYaml(tmp, "codex", {
        name: "codex",
        binary: "codex",
        agent_config_env: "CODEX_HOME",
        session_log_dir: "${CODEX_HOME}/sessions",
        session_log_glob: "*.jsonl",
        normalizer: "claude",
        required_env: [],
      });
      const cfg = loadCodingAgentConfig(path);
      expect(cfg.runtimeFamily).toBe("codex");
      expect(cfg.model).toBeNull();
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("valid claude variant loads runtime_family and model", () => {
    const tmp = makeTmpDir();
    try {
      const path = writeYaml(tmp, "claude-haiku", {
        name: "claude-haiku",
        runtime_family: "claude",
        binary: "claude",
        agent_config_env: "CLAUDE_CONFIG_DIR",
        session_log_dir: "${CLAUDE_CONFIG_DIR}/projects",
        session_log_glob: "**/*.jsonl",
        normalizer: "claude",
        required_env: [],
        model: "claude-haiku-4-5-20251001",
      });
      const cfg = loadCodingAgentConfig(path);
      expect(cfg.name).toBe("claude-haiku");
      expect(cfg.runtimeFamily).toBe("claude");
      expect(cfg.model).toBe("claude-haiku-4-5-20251001");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("file stem must match name", () => {
    const tmp = makeTmpDir();
    try {
      const path = writeYaml(tmp, "claude-haiku", {
        name: "claude",
        runtime_family: "claude",
        binary: "claude",
        agent_config_env: "CLAUDE_CONFIG_DIR",
        session_log_dir: "${CLAUDE_CONFIG_DIR}/projects",
        session_log_glob: "**/*.jsonl",
        normalizer: "claude",
        required_env: [],
        model: "claude-haiku-4-5-20251001",
      });
      expect(() => loadCodingAgentConfig(path)).toThrow(/name must match file stem/);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("unknown runtime_family raises", () => {
    const tmp = makeTmpDir();
    try {
      const path = writeYaml(tmp, "strange", {
        name: "strange",
        runtime_family: "strange",
        binary: "strange",
        agent_config_env: "STRANGE_HOME",
        session_log_dir: "/tmp/strange",
        session_log_glob: "*.jsonl",
        normalizer: "claude",
        required_env: [],
      });
      expect(() => loadCodingAgentConfig(path)).toThrow(/unknown runtime_family/);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("claude family requires model", () => {
    const tmp = makeTmpDir();
    try {
      const path = writeYaml(tmp, "claude-haiku", {
        name: "claude-haiku",
        runtime_family: "claude",
        binary: "claude",
        agent_config_env: "CLAUDE_CONFIG_DIR",
        session_log_dir: "${CLAUDE_CONFIG_DIR}/projects",
        session_log_glob: "**/*.jsonl",
        normalizer: "claude",
        required_env: [],
      });
      expect(() => loadCodingAgentConfig(path)).toThrow(/model/);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("model must not be blank", () => {
    const tmp = makeTmpDir();
    try {
      const path = writeYaml(tmp, "claude-haiku", {
        name: "claude-haiku",
        runtime_family: "claude",
        binary: "claude",
        agent_config_env: "CLAUDE_CONFIG_DIR",
        session_log_dir: "${CLAUDE_CONFIG_DIR}/projects",
        session_log_glob: "**/*.jsonl",
        normalizer: "claude",
        required_env: [],
        model: " ",
      });
      expect(() => loadCodingAgentConfig(path)).toThrow(/model must not be blank/);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("model must be string when provided", () => {
    const tmp = makeTmpDir();
    try {
      const path = writeYaml(tmp, "codex", {
        name: "codex",
        binary: "codex",
        agent_config_env: "CODEX_HOME",
        session_log_dir: "${CODEX_HOME}/sessions",
        session_log_glob: "*.jsonl",
        normalizer: "claude",
        required_env: [],
        model: 123,
      });
      expect(() => loadCodingAgentConfig(path)).toThrow(/model must be a string/);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("non-claude variant is rejected in v1", () => {
    const tmp = makeTmpDir();
    try {
      const path = writeYaml(tmp, "opencode-claude", {
        name: "opencode-claude",
        runtime_family: "opencode",
        binary: "opencode",
        agent_config_env: "OPENCODE_QUORUM_HOME",
        session_log_dir: "${OPENCODE_QUORUM_HOME}/sessions",
        session_log_glob: "*.json",
        normalizer: "opencode",
        required_env: [],
        model: "anthropic/claude-sonnet-4-6",
      });
      expect(() => loadCodingAgentConfig(path)).toThrow(/non-Claude variants/);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("resolveSessionLogDir substitutes agent config env", () => {
    const tmp = makeTmpDir();
    try {
      process.env["ANTHROPIC_API_KEY"] = "x";
      const path = writeYaml(tmp, "claude", {
        name: "claude",
        binary: "claude",
        agent_config_env: "CLAUDE_CONFIG_DIR",
        session_log_dir: "${CLAUDE_CONFIG_DIR}/projects",
        session_log_glob: "*.jsonl",
        normalizer: "claude",
        required_env: [],
        model: "opus",
      });
      const cfg = loadCodingAgentConfig(path);
      const resolved = cfg.resolveSessionLogDir("/tmp/agent-cfg");
      expect(resolved).toBe("/tmp/agent-cfg/projects");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("resolveSessionLogDir literal path unchanged (no placeholder)", () => {
    const tmp = makeTmpDir();
    try {
      const path = writeYaml(tmp, "codex", {
        name: "codex",
        binary: "codex",
        agent_config_env: "CODEX_HOME",
        session_log_dir: "~/literal/path",
        session_log_glob: "*.jsonl",
        normalizer: "claude",
        required_env: [],
      });
      const cfg = loadCodingAgentConfig(path);
      const resolved = cfg.resolveSessionLogDir("/tmp/ignored");
      // expanduser equivalent: replace leading ~ with HOME
      const home = process.env["HOME"] ?? "";
      expect(resolved).toBe(join(home, "literal/path"));
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("missing required env raises", () => {
    const tmp = makeTmpDir();
    try {
      delete process.env["ANTHROPIC_API_KEY"];
      const path = writeYaml(tmp, "claude", {
        name: "claude",
        binary: "claude",
        agent_config_env: "CLAUDE_CONFIG_DIR",
        session_log_dir: "/tmp",
        session_log_glob: "*.jsonl",
        normalizer: "claude",
        required_env: ["ANTHROPIC_API_KEY"],
        model: "opus",
      });
      expect(() => loadCodingAgentConfig(path)).toThrow(/ANTHROPIC_API_KEY/);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("missing agent_config_env field raises", () => {
    const tmp = makeTmpDir();
    try {
      const path = writeYaml(tmp, "claude", {
        name: "claude",
        binary: "claude",
        session_log_dir: "/tmp",
        session_log_glob: "*.jsonl",
        normalizer: "claude",
        required_env: [],
      });
      expect(() => loadCodingAgentConfig(path)).toThrow(/agent_config_env/);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("unknown normalizer raises", () => {
    const tmp = makeTmpDir();
    try {
      const path = writeYaml(tmp, "codex", {
        name: "codex",
        binary: "codex",
        agent_config_env: "CODEX_HOME",
        session_log_dir: "/tmp",
        session_log_glob: "*.jsonl",
        normalizer: "weirdo",
        required_env: [],
      });
      expect(() => loadCodingAgentConfig(path)).toThrow(/weirdo/);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("max_time optional", () => {
    const tmp = makeTmpDir();
    try {
      process.env["ANTHROPIC_API_KEY"] = "x";
      const path = writeYaml(tmp, "claude", {
        name: "claude",
        binary: "claude",
        agent_config_env: "CLAUDE_CONFIG_DIR",
        session_log_dir: "/tmp",
        session_log_glob: "*.jsonl",
        normalizer: "claude",
        required_env: [],
        max_time: "5m",
        model: "opus",
      });
      const cfg = loadCodingAgentConfig(path);
      expect(cfg.maxTime).toBe("5m");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("top-level must be a mapping", () => {
    const tmp = makeTmpDir();
    try {
      const p = join(tmp, "claude.yaml");
      writeFileSync(p, "- item1\n- item2\n");
      expect(() => loadCodingAgentConfig(p)).toThrow(/top-level must be a mapping/);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("missing required fields raises", () => {
    const tmp = makeTmpDir();
    try {
      const path = writeYaml(tmp, "claude", {
        name: "claude",
        // missing all other required fields
      });
      expect(() => loadCodingAgentConfig(path)).toThrow(/missing required fields/);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// SUPPORTED_NORMALIZERS and KNOWN_RUNTIME_FAMILIES exports
// ---------------------------------------------------------------------------

test("SUPPORTED_NORMALIZERS contains the 8 expected agents", () => {
  const expected = new Set(["claude", "codex", "gemini", "copilot", "opencode", "pi", "kimi", "antigravity"]);
  expect(SUPPORTED_NORMALIZERS).toEqual(expected);
});

test("KNOWN_RUNTIME_FAMILIES contains the 8 expected families", () => {
  const expected = new Set(["antigravity", "claude", "codex", "copilot", "gemini", "kimi", "opencode", "pi"]);
  expect(KNOWN_RUNTIME_FAMILIES).toEqual(expected);
});
