from __future__ import annotations

import sys
from pathlib import Path

from quorum.locks import LockRequest, acquire_locks, release_locks
from quorum.managed_state import discover_managed_paths


def main() -> int:
    if len(sys.argv) != 4:
        print("usage: lock_holder.py STATE_ROOT LOCK_NAME JOB_ID", file=sys.stderr)
        return 2

    state_root = Path(sys.argv[1])
    lock_name = sys.argv[2]
    job_id = sys.argv[3]
    paths = discover_managed_paths({"QUORUM_STATE_ROOT": str(state_root)})

    held = acquire_locks(
        paths,
        [LockRequest(lock_name)],
        job_id=job_id,
        command=["lock-holder", lock_name],
    )
    try:
        print("locked", flush=True)
        sys.stdin.readline()
    finally:
        release_locks(held)

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
