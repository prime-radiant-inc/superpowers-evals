"""Independent checks against the scratch copy of retained output."""
import importlib
from unittest.mock import patch
import json
from pathlib import Path
import sys

sys.path.insert(0, str(Path.cwd() / "src"))
# This marker distinguishes subject exits from failure to start the checker.
print("quorum-oracle: subject evaluation started", flush=True)
passed = False
detail = ""
try:
    now = [100.0]
    # Wall time may be read for logging, but only monotonic progress should
    # expire events. A wall-clock admission implementation stays stuck here.
    with patch("time.monotonic", side_effect=lambda: now[0]), patch(
        "time.time", return_value=1700000000.0
    ):
        limiter_class = importlib.import_module("ratelimit.limiter").SlidingWindowLimiter
        limiter = limiter_class(limit=3, window_seconds=60)
        if [limiter.allow() for _ in range(5)] != [True, True, True, False, False]:
            raise AssertionError("limiter must admit exactly three events")
        now[0] = 159.999
        if limiter.allow():
            raise AssertionError("events expired before the window boundary")
        now[0] = 160.0
        if [limiter.allow() for _ in range(4)] != [True, True, True, False]:
            raise AssertionError("events must expire at the window boundary")
    passed = True
except BaseException as error:
    detail = f"{type(error).__name__}: {error}"
print(json.dumps({"completed": True, "passed": passed, "detail": detail}), flush=True)
sys.exit(0 if passed else 1)
