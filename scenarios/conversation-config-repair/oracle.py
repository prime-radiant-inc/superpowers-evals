"""Evaluate retained output in a disposable copy, isolated from cleanup."""

import json
import os
from pathlib import Path
import shutil
import signal
import subprocess
import sys
import tempfile


MARKER = "quorum-oracle: subject evaluation started"


def evaluate_subject() -> int:
    print(MARKER, flush=True)
    passed = False
    detail = ""
    try:
        sys.path.insert(0, str(Path.cwd() / "src"))
        load_config = __import__("configkit.loader", fromlist=["load_config"]).load_config
        cases = [
            ({}, None, {"retries": 3, "tracing": True}),
            ({"retries": 7, "tracing": False}, None, {"retries": 7, "tracing": False}),
            ({"retries": 0, "tracing": False}, None, {"retries": 0, "tracing": False}),
            (
                {"retries": 1, "tracing": False},
                {"retries": 8, "tracing": True},
                {"retries": 8, "tracing": True},
            ),
            (
                {"retries": 9, "tracing": True},
                {"retries": 0, "tracing": False},
                {"retries": 0, "tracing": False},
            ),
            (
                {"retries": 6, "tracing": False},
                {"retries": 2},
                {"retries": 2, "tracing": False},
            ),
            (
                {"retries": 6, "tracing": False},
                {"tracing": True},
                {"retries": 6, "tracing": True},
            ),
        ]
        with tempfile.TemporaryDirectory(prefix="config-cases-", dir=Path.cwd()) as root:
            config_path = Path(root) / "config.json"
            for values, overrides, expected in cases:
                config_path.write_text(json.dumps(values))
                actual = load_config(config_path, overrides)
                if actual != expected:
                    raise AssertionError(
                        f"load_config({values!r}, {overrides!r}) returned {actual!r}; "
                        f"expected {expected!r}"
                    )
                if type(actual) is not dict:
                    raise AssertionError(f"load_config returned {type(actual).__name__}, expected dict")
                if type(actual.get("retries")) is not int:
                    raise AssertionError("retries must be an integer")
                if type(actual.get("tracing")) is not bool:
                    raise AssertionError("tracing must be a boolean")
        passed = True
    except BaseException as error:
        detail = f"{type(error).__name__}: {error}"
    print(json.dumps({"completed": True, "passed": passed, "detail": detail}), flush=True)
    return 0 if passed else 1


def run_parent() -> int:
    scratch = None
    result = None
    checker_failed = False
    try:
        scratch_root = os.environ.get("TMPDIR")
        if not scratch_root:
            raise RuntimeError("TMPDIR is required")
        checker = Path(__file__).resolve()
        if not checker.is_file() or not os.access(checker, os.R_OK):
            raise RuntimeError("checker is not readable")
        runtime = Path(sys.executable)
        if not runtime.is_file() or not os.access(runtime, os.X_OK):
            raise RuntimeError("Python runtime is unavailable")
        scratch = Path(tempfile.mkdtemp(prefix="conversation-oracle-", dir=scratch_root))
        output = scratch / "output"
        shutil.copytree(Path.cwd(), output, symlinks=True)
        result = subprocess.run(
            [sys.executable, "-I", str(checker), "--evaluate"],
            cwd=output,
            capture_output=True,
            text=True,
            timeout=10,
            check=False,
        )
    except (OSError, RuntimeError, subprocess.SubprocessError) as error:
        print(f"checker error: {error}", file=sys.stderr)
        checker_failed = True
    finally:
        if scratch is not None:
            try:
                shutil.rmtree(scratch)
            except OSError as error:
                print(f"checker cleanup error: {error}", file=sys.stderr)
                checker_failed = True

    if checker_failed or result is None:
        return 127
    if result.returncode < 0:
        signum = -result.returncode
        signal.signal(signum, signal.SIG_DFL)
        os.kill(os.getpid(), signum)
        return 128 + signum

    lines = result.stdout.rstrip().splitlines()
    started = MARKER in lines
    receipt = None
    if lines:
        try:
            receipt = json.loads(lines[-1])
        except json.JSONDecodeError:
            pass
    if not started:
        print(
            f"checker failed before evaluating subject: {result.stderr}",
            file=sys.stderr,
        )
        return 127
    if (
        result.returncode == 0
        and isinstance(receipt, dict)
        and receipt.get("completed") is True
        and receipt.get("passed") is True
    ):
        print("conversation oracle: pass")
        return 0

    detail = (
        receipt.get("detail")
        if isinstance(receipt, dict) and isinstance(receipt.get("detail"), str)
        else "subject exited before assertions completed"
    )
    print(f"conversation oracle: fail ({detail})")
    return 1


if __name__ == "__main__":
    if sys.argv[1:] == ["--evaluate"]:
        raise SystemExit(evaluate_subject())
    if sys.argv[1:]:
        print("checker error: unsupported arguments", file=sys.stderr)
        raise SystemExit(127)
    raise SystemExit(run_parent())
