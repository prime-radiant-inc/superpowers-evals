from pathlib import Path

INTENTIONAL_PINNED_SCENARIOS = {
    "antigravity-superpowers-bootstrap",
    "codex-native-hooks-bootstrap",
    "codex-subagent-wait-mapping",
    "codex-tool-mapping-comprehension",
    "copilot-superpowers-bootstrap",
    "gemini-superpowers-bootstrap",
    "kimi-superpowers-bootstrap",
    "opencode-superpowers-bootstrap",
    "pi-superpowers-bootstrap",
    "sdd-spec-context-consumed",
    "worktree-creation-under-pressure",
    "worktree-no-drift-to-main",
}


def _coding_agents_directive(checks_path: Path) -> str | None:
    for line in checks_path.read_text().splitlines():
        if line.startswith("# coding-agents:"):
            return line.split(":", 1)[1].strip()
        if line.strip() and not line.startswith("#"):
            return None
    return None


def test_harness_pins_are_explicitly_intentional():
    scenario_root = Path(__file__).resolve().parents[2] / "scenarios"
    pinned = {
        scenario_dir.name
        for scenario_dir in scenario_root.iterdir()
        if scenario_dir.is_dir()
        and _coding_agents_directive(scenario_dir / "checks.sh") is not None
    }

    assert pinned == INTENTIONAL_PINNED_SCENARIOS
