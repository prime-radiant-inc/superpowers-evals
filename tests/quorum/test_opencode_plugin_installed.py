import json
import os
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
TOOL = ROOT / "bin" / "opencode-plugin-installed"


def _run_tool(run_dir: Path) -> tuple[int, list[dict]]:
    sink = run_dir / "records.jsonl"
    env = {
        **os.environ,
        "QUORUM_RUN_DIR": str(run_dir),
        "QUORUM_RECORD_SINK": str(sink),
        "PATH": f"{ROOT / 'bin'}:{os.environ.get('PATH', '')}",
    }
    proc = subprocess.run([str(TOOL)], text=True, capture_output=True, env=env)
    records = [json.loads(line) for line in sink.read_text().splitlines() if line.strip()]
    return proc.returncode, records


def test_opencode_plugin_installed_passes_for_staged_layout(tmp_path):
    cfg = tmp_path / "coding-agent-config" / ".config" / "opencode"
    plugin = cfg / "plugins" / "superpowers.js"
    skill = cfg / "superpowers" / "skills" / "using-superpowers" / "SKILL.md"
    plugin.parent.mkdir(parents=True)
    skill.parent.mkdir(parents=True)
    plugin.write_text("export {};")
    skill.write_text("skill")

    code, records = _run_tool(tmp_path)

    assert code == 0
    assert records[0]["passed"] is True


def test_opencode_plugin_installed_fails_when_plugin_missing(tmp_path):
    code, records = _run_tool(tmp_path)

    assert code != 0
    assert records[0]["passed"] is False
    assert "plugin missing" in records[0]["detail"]


def test_opencode_plugin_installed_uses_current_run_dir_over_ambient_home(tmp_path, monkeypatch):
    ambient = tmp_path / "ambient"
    ambient_cfg = ambient / ".config" / "opencode"
    ambient_plugin = ambient_cfg / "plugins" / "superpowers.js"
    ambient_skill = ambient_cfg / "superpowers" / "skills" / "using-superpowers" / "SKILL.md"
    ambient_plugin.parent.mkdir(parents=True)
    ambient_skill.parent.mkdir(parents=True)
    ambient_plugin.write_text("export {};")
    ambient_skill.write_text("skill")
    monkeypatch.setenv("OPENCODE_QUORUM_HOME", str(ambient))

    code, records = _run_tool(tmp_path)

    assert code != 0
    assert records[0]["passed"] is False
    assert "coding-agent-config" in records[0]["detail"]
