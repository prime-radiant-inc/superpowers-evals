from quorum.agy_teardown import kill_run_tmux_server


def make_runner(panes):
    """Return a (runner, calls) pair.

    runner() records every command it receives and, when the command is a
    list-panes call, returns the canned stdout for that socket name.
    """
    calls = []

    def runner(cmd, **kw):
        calls.append(cmd)

        class R:
            returncode = 0
            stdout = ""
            stderr = ""

        if "list-panes" in cmd:
            name = cmd[2]
            R.stdout = panes.get(name, "")
        return R

    return runner, calls


def test_kills_the_server_under_the_scratch_dir(tmp_path, monkeypatch):
    scratch = tmp_path / "run123" / "gauntlet-agent" / "scratch"
    scratch.mkdir(parents=True)
    # two private servers exist; only B's pane is under our scratch dir
    monkeypatch.setattr(
        "quorum.agy_teardown._list_gauntlet_sockets",
        lambda: ["gauntlet-1-aaaaaa", "gauntlet-2-bbbbbb"],
    )
    panes = {
        "gauntlet-1-aaaaaa": "/some/other/scratch\n",
        "gauntlet-2-bbbbbb": f"{scratch}\n",
    }
    runner, calls = make_runner(panes)
    killed = kill_run_tmux_server(scratch, runner=runner)
    assert killed is True
    assert ["tmux", "-L", "gauntlet-2-bbbbbb", "kill-server"] in calls
    assert ["tmux", "-L", "gauntlet-1-aaaaaa", "kill-server"] not in calls


def test_no_match_returns_false(tmp_path, monkeypatch):
    monkeypatch.setattr("quorum.agy_teardown._list_gauntlet_sockets", lambda: [])
    assert kill_run_tmux_server(tmp_path, runner=lambda *a, **k: None) is False


def test_does_not_false_match_sibling_dir(tmp_path, monkeypatch):
    """A server whose pane path is a sibling of scratch must not be killed."""
    scratch = tmp_path / "run123" / "gauntlet-agent" / "scratch"
    scratch.mkdir(parents=True)
    sibling = tmp_path / "run123" / "gauntlet-agent" / "scratch-extra"
    sibling.mkdir(parents=True)

    monkeypatch.setattr(
        "quorum.agy_teardown._list_gauntlet_sockets",
        lambda: ["gauntlet-1-aaaaaa"],
    )
    # pane cwd is the sibling, not scratch itself
    panes = {"gauntlet-1-aaaaaa": f"{sibling}\n"}
    runner, calls = make_runner(panes)
    killed = kill_run_tmux_server(scratch, runner=runner)
    assert killed is False
    assert ["tmux", "-L", "gauntlet-1-aaaaaa", "kill-server"] not in calls


def test_non_matching_pane_returns_false(tmp_path, monkeypatch):
    monkeypatch.setattr(
        "quorum.agy_teardown._list_gauntlet_sockets",
        lambda: ["gauntlet-1-aaaaaa"],
    )
    panes = {"gauntlet-1-aaaaaa": "/unrelated/path\n"}
    runner, calls = make_runner(panes)
    killed = kill_run_tmux_server(tmp_path, runner=runner)
    assert killed is False


def test_stops_at_first_match(tmp_path, monkeypatch):
    """Once the matching server is found and killed, remaining servers are skipped."""
    scratch = tmp_path / "run456" / "gauntlet-agent" / "scratch"
    scratch.mkdir(parents=True)

    monkeypatch.setattr(
        "quorum.agy_teardown._list_gauntlet_sockets",
        lambda: ["gauntlet-1-aaaaaa", "gauntlet-2-bbbbbb"],
    )
    # First server matches; second should never be queried.
    panes = {
        "gauntlet-1-aaaaaa": f"{scratch}\n",
        "gauntlet-2-bbbbbb": "/some/other/path\n",
    }
    runner, calls = make_runner(panes)
    killed = kill_run_tmux_server(scratch, runner=runner)
    assert killed is True
    # The second server's list-panes must NOT have been called.
    list_panes_targets = [c[2] for c in calls if "list-panes" in c]
    assert "gauntlet-2-bbbbbb" not in list_panes_targets
