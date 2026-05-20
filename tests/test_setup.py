import os
import subprocess
from pathlib import Path
from unittest.mock import call, patch

import pytest

from drill.setup import clone_template, run_assertions
from setup_helpers.base import create_base_repo
from setup_helpers.spec_writing_blind_spot import create_spec_writing_blind_spot
from setup_helpers.worktree import (
    _select_codex_superpowers_hook,
    add_worktree,
    create_caller_consent_plan,
    detach_head,
    install_codex_superpowers_plugin_hooks,
    link_gemini_extension,
    symlink_superpowers,
)


@pytest.fixture
def fixtures_dir():
    return Path(__file__).parent.parent / "fixtures"


@pytest.fixture
def work_dir(tmp_path):
    return tmp_path / "test-repo"


class TestCloneTemplate:
    def test_clones_template_repo(self, fixtures_dir, work_dir):
        clone_template(fixtures_dir / "template-repo", work_dir)
        assert (work_dir / "package.json").exists()
        assert (work_dir / "src" / "index.js").exists()
        result = subprocess.run(
            ["git", "log", "--oneline"],
            cwd=work_dir,
            capture_output=True,
            text=True,
        )
        assert "initial commit" in result.stdout


class TestCreateBaseRepo:
    def test_creates_base_repo(self, fixtures_dir, work_dir):
        create_base_repo(work_dir, fixtures_dir / "template-repo")
        assert (work_dir / "package.json").exists()
        result = subprocess.run(
            ["git", "branch", "--show-current"],
            cwd=work_dir,
            capture_output=True,
            text=True,
        )
        assert result.stdout.strip() == "main"


class TestWorktreeHelpers:
    def test_add_worktree(self, fixtures_dir, work_dir):
        create_base_repo(work_dir, fixtures_dir / "template-repo")
        wt_path = work_dir.parent / "feature-wt"
        add_worktree(work_dir, "feature-branch", str(wt_path))
        assert wt_path.exists()
        result = subprocess.run(
            ["git", "worktree", "list"],
            cwd=work_dir,
            capture_output=True,
            text=True,
        )
        assert "feature-branch" in result.stdout

    def test_detach_head(self, fixtures_dir, work_dir):
        create_base_repo(work_dir, fixtures_dir / "template-repo")
        wt_path = work_dir.parent / "detached-wt"
        add_worktree(work_dir, "tmp-branch", str(wt_path))
        detach_head(str(wt_path))
        result = subprocess.run(
            ["git", "branch", "--show-current"],
            cwd=wt_path,
            capture_output=True,
            text=True,
        )
        assert result.stdout.strip() == ""

    def test_symlink_superpowers(self, fixtures_dir, work_dir, tmp_path):
        create_base_repo(work_dir, fixtures_dir / "template-repo")
        fake_sp = tmp_path / "superpowers" / "skills"
        fake_sp.mkdir(parents=True)
        symlink_superpowers(work_dir, str(tmp_path / "superpowers"))
        link = work_dir / ".agents" / "skills" / "superpowers"
        assert link.is_symlink()

    def test_link_gemini_extension_relinks_requested_root(self, work_dir, tmp_path):
        work_dir.mkdir()
        fake_sp = tmp_path / "superpowers"
        (fake_sp / "skills" / "using-superpowers" / "references").mkdir(parents=True)
        (fake_sp / "gemini-extension.json").write_text('{"name": "custom-superpowers"}')

        with patch("setup_helpers.worktree.subprocess.run") as run:
            link_gemini_extension(work_dir, str(fake_sp))

        assert run.call_args_list == [
            call(["gemini", "extensions", "uninstall", "custom-superpowers"], capture_output=True),
            call(
                ["gemini", "extensions", "link", str(fake_sp)],
                capture_output=True,
                input="y\n",
                text=True,
                check=True,
            ),
        ]
        assert (work_dir / "GEMINI.md").read_text() == (
            f"@{fake_sp}/skills/using-superpowers/SKILL.md\n"
            f"@{fake_sp}/skills/using-superpowers/references/gemini-tools.md\n"
        )

    def test_install_codex_superpowers_plugin_hooks_stages_isolated_home(
        self, work_dir, tmp_path, monkeypatch
    ):
        work_dir.mkdir()
        fake_sp = tmp_path / "superpowers"
        (fake_sp / ".codex-plugin").mkdir(parents=True)
        (fake_sp / ".codex-plugin" / "plugin.json").write_text('{"name":"superpowers"}\n')
        (fake_sp / "hooks").mkdir()
        (fake_sp / "hooks" / "hooks-codex.json").write_text('{"hooks":{}}\n')
        (fake_sp / "hooks" / "session-start").write_text("#!/usr/bin/env sh\n")
        (fake_sp / "hooks" / "run-hook.cmd").write_text("@echo off\n")
        (fake_sp / "skills" / "using-superpowers").mkdir(parents=True)
        (fake_sp / "skills" / "using-superpowers" / "SKILL.md").write_text("# Skill\n")

        hook = {
            "key": "superpowers@debug:hooks/hooks-codex.json:session_start:0:0",
            "currentHash": "sha256:abc123",
        }
        monkeypatch.setenv("OPENAI_API_KEY", "sk-test")
        monkeypatch.delenv("DRILL_CODEX_HOME", raising=False)

        with (
            patch("setup_helpers.worktree._read_codex_superpowers_hook", return_value=hook),
            patch("setup_helpers.worktree.subprocess.run") as run,
        ):
            install_codex_superpowers_plugin_hooks(work_dir, str(fake_sp))

        codex_home = work_dir.parent / f"{work_dir.name}-codex-home"
        staged_plugin = codex_home / "plugins" / "cache" / "debug" / "superpowers" / "local"
        assert (staged_plugin / ".codex-plugin" / "plugin.json").exists()
        assert (staged_plugin / "hooks" / "hooks-codex.json").exists()
        assert os.environ["DRILL_CODEX_HOME"] == str(codex_home)

        config = (codex_home / "config.toml").read_text()
        assert "plugin_hooks = true" in config
        assert '[plugins."superpowers@debug"]' in config
        assert (
            '[hooks.state."superpowers@debug:hooks/hooks-codex.json:session_start:0:0"]'
            in config
        )
        assert 'trusted_hash = "sha256:abc123"' in config
        run.assert_called_once()
        args, kwargs = run.call_args
        assert args == (["codex", "login", "--with-api-key"],)
        assert kwargs["input"] == "sk-test\n"
        assert kwargs["text"] is True
        assert kwargs["capture_output"] is True
        assert kwargs["check"] is True
        assert kwargs["env"]["CODEX_HOME"] == str(codex_home)
        assert kwargs["env"]["OPENAI_API_KEY"] == "sk-test"

    def test_select_codex_superpowers_hook_requires_codex_entrypoint(self):
        response = {
            "result": {
                "data": [
                    {
                        "hooks": [
                            {
                                "pluginId": "superpowers@debug",
                                "source": "plugin",
                                "eventName": "sessionStart",
                                "matcher": "startup|resume|clear",
                                "command": (
                                    '"${PLUGIN_ROOT}/hooks/run-hook.cmd" session-start-codex'
                                ),
                                "trustStatus": "untrusted",
                                "key": "superpowers@debug:hooks/hooks-codex.json:session_start:0:0",
                                "currentHash": "sha256:abc123",
                            }
                        ]
                    }
                ]
            }
        }

        hook = _select_codex_superpowers_hook(response)

        assert hook == {
            "key": "superpowers@debug:hooks/hooks-codex.json:session_start:0:0",
            "currentHash": "sha256:abc123",
        }

    def test_select_codex_superpowers_hook_rejects_shared_entrypoint(self):
        response = {
            "result": {
                "data": [
                    {
                        "hooks": [
                            {
                                "pluginId": "superpowers@debug",
                                "source": "plugin",
                                "eventName": "sessionStart",
                                "matcher": "startup|resume|clear",
                                "command": '"${PLUGIN_ROOT}/hooks/run-hook.cmd" session-start',
                                "trustStatus": "untrusted",
                                "key": "superpowers@debug:hooks/hooks-codex.json:session_start:0:0",
                                "currentHash": "sha256:abc123",
                            }
                        ]
                    }
                ]
            }
        }

        with pytest.raises(RuntimeError, match="session-start-codex"):
            _select_codex_superpowers_hook(response)

    def test_select_codex_superpowers_hook_accepts_revised_matcher(self):
        # Superpowers revises which lifecycle events the hook fires on
        # (was startup|resume|clear, later startup|clear|compact). Only
        # `startup` is load-bearing; the rest must not pin drill.
        response = {
            "result": {
                "data": [
                    {
                        "hooks": [
                            {
                                "pluginId": "superpowers@debug",
                                "source": "plugin",
                                "eventName": "sessionStart",
                                "matcher": "startup|clear|compact",
                                "command": (
                                    '"${PLUGIN_ROOT}/hooks/run-hook.cmd" session-start-codex'
                                ),
                                "trustStatus": "untrusted",
                                "key": "superpowers@debug:hooks/hooks-codex.json:session_start:0:0",
                                "currentHash": "sha256:abc123",
                            }
                        ]
                    }
                ]
            }
        }

        hook = _select_codex_superpowers_hook(response)

        assert hook["key"].startswith("superpowers@debug:")

    def test_select_codex_superpowers_hook_rejects_matcher_without_startup(self):
        response = {
            "result": {
                "data": [
                    {
                        "hooks": [
                            {
                                "pluginId": "superpowers@debug",
                                "source": "plugin",
                                "eventName": "sessionStart",
                                "matcher": "resume|clear",
                                "command": (
                                    '"${PLUGIN_ROOT}/hooks/run-hook.cmd" session-start-codex'
                                ),
                                "trustStatus": "untrusted",
                                "key": "superpowers@debug:hooks/hooks-codex.json:session_start:0:0",
                                "currentHash": "sha256:abc123",
                            }
                        ]
                    }
                ]
            }
        }

        with pytest.raises(RuntimeError, match="session startup"):
            _select_codex_superpowers_hook(response)

    def test_create_caller_consent_plan(self, fixtures_dir, work_dir):
        create_base_repo(work_dir, fixtures_dir / "template-repo")
        create_caller_consent_plan(work_dir)

        plan = work_dir / "docs" / "superpowers" / "plans" / "custom-greeting.md"
        assert plan.exists()
        assert "REQUIRED SUB-SKILL" in plan.read_text()

        result = subprocess.run(
            ["git", "status", "--short"],
            cwd=work_dir,
            capture_output=True,
            text=True,
        )
        assert result.stdout.strip() == ""


class TestSpecWritingBlindSpot:
    def test_creates_repo_structure(self, tmp_path):
        workdir = tmp_path / "blind-spot-repo"
        create_spec_writing_blind_spot(workdir)

        assert (workdir / "src" / "components" / "AdminPanel.tsx").exists()
        assert (workdir / "src" / "components" / "TeamOverview.tsx").exists()
        assert (workdir / "src" / "router.tsx").exists()
        assert (workdir / "CLAUDE.md").exists()
        assert not (workdir / "src" / "components" / "ActivityFeed.tsx").exists()

        result = subprocess.run(
            ["git", "branch", "--show-current"],
            cwd=workdir,
            capture_output=True,
            text=True,
        )
        assert result.stdout.strip() == "main"

        result = subprocess.run(
            ["git", "log", "--oneline"],
            cwd=workdir,
            capture_output=True,
            text=True,
        )
        assert result.stdout.count("\n") >= 3


class TestRunAssertions:
    def test_passing_assertions(self, fixtures_dir, work_dir):
        create_base_repo(work_dir, fixtures_dir / "template-repo")
        assertions = [
            "git rev-parse --is-inside-work-tree",
            "git branch --show-current | grep main",
        ]
        run_assertions(assertions, work_dir)

    def test_failing_assertion_raises(self, fixtures_dir, work_dir):
        create_base_repo(work_dir, fixtures_dir / "template-repo")
        with pytest.raises(AssertionError, match="Setup assertion failed"):
            run_assertions(["git branch --show-current | grep nonexistent"], work_dir)
