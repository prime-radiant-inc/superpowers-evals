"""Kill gauntlet's private named-socket tmux server for a given run.

Gauntlet drives agy inside a per-session tmux server addressed by a randomly
chosen named socket (`gauntlet-<epoch>-<rand>`).  The name is chosen at
runtime inside gauntlet — quorum cannot pre-compute it.  Killing the
launcher's process group does NOT reap agy because tmux reparents panes to
PID 1; only `tmux -L <name> kill-server` does (gauntlet's own teardown path).

Discovery strategy: glob the tmux socket dir for `gauntlet-*` sockets, then
query each server for its pane cwd.  The server whose pane path resolves to
exactly the run's scratch directory is THIS run's server.  Equality on resolved
paths (not substring) guards against false-matching a sibling directory such as
`scratch-extra`.
"""

from __future__ import annotations

import os
import pathlib
import subprocess


def _socket_dir() -> pathlib.Path:
    base = os.environ.get("TMUX_TMPDIR", "/tmp")
    return pathlib.Path(base) / f"tmux-{os.getuid()}"


def _list_gauntlet_sockets() -> list[str]:
    d = _socket_dir()
    return sorted(p.name for p in d.glob("gauntlet-*")) if d.is_dir() else []


def _pane_path(name: str, runner) -> str:
    r = runner(
        ["tmux", "-L", name, "list-panes", "-a", "-F", "#{pane_start_path}"],
        capture_output=True,
        text=True,
    )
    # A non-zero exit (e.g. the server died between the glob and this query)
    # yields no stdout, so this returns "" and the caller simply skips it.
    return (getattr(r, "stdout", "") or "").strip()


def kill_run_tmux_server(scratch_dir: os.PathLike | str, *, runner=subprocess.run) -> bool:
    """Kill the gauntlet tmux server whose pane started in *scratch_dir*.

    Returns True if a matching server was found and a ``kill-server`` was
    dispatched (best-effort — not a guarantee the kill itself succeeded); False
    if no gauntlet server's pane matched the run's scratch directory.
    """
    target = str(pathlib.Path(scratch_dir).resolve())
    for name in _list_gauntlet_sockets():
        for line in _pane_path(name, runner).splitlines():
            resolved = str(pathlib.Path(line.strip()).resolve())
            if resolved == target:
                runner(["tmux", "-L", name, "kill-server"])
                return True
    return False
