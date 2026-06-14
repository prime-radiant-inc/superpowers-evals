"""Protect agy's shared OAuth token around a mid-run kill.

agy reads auth from the live, token-rotating ~/.gemini/oauth_creds.json.
A SIGKILL during a token refresh can leave the file half-written and
unparseable, permanently locking the account (A4 of the agy reliability spec).
Backup before the run; read-back after: if the file is corrupt, restore it.
A legitimate token refresh changes bytes but stays valid JSON — leave it alone.
"""

from __future__ import annotations

import contextlib
import json
import os
import shutil
import tempfile
from dataclasses import dataclass
from pathlib import Path

_CRED_PATH = Path.home() / ".gemini" / "oauth_creds.json"


@dataclass
class CredBackup:
    live: Path
    backup: Path

    def verify_or_restore(self) -> None:
        """Restore from backup only if the live file is missing or corrupt JSON.

        Best-effort and never raises — it runs in a teardown ``finally`` after a
        possibly-failing run, so it must not mask the in-flight exception. Always
        cleans up the temp backup file.
        """
        corrupt = True
        try:
            if self.live.exists():
                json.loads(self.live.read_text())
                corrupt = False  # valid JSON — legitimate refresh or unchanged
        except (json.JSONDecodeError, OSError):
            pass
        if corrupt:
            with contextlib.suppress(OSError):
                shutil.copy2(self.backup, self.live)
        with contextlib.suppress(OSError):
            self.backup.unlink()


def backup_credential() -> CredBackup | None:
    """Copy the live credential to a temp file and return a CredBackup handle.

    Returns None if the credential file does not exist (nothing to protect;
    the caller should skip restore logic entirely).
    """
    if not _CRED_PATH.exists():
        return None
    fd, tmp = tempfile.mkstemp(prefix="agy_creds_backup_", suffix=".json")
    os.close(fd)
    backup = Path(tmp)
    shutil.copy2(_CRED_PATH, backup)
    return CredBackup(live=_CRED_PATH, backup=backup)
