"""Independent checks against the scratch copy of retained output."""
import importlib
import json
from pathlib import Path
import sys

sys.path.insert(0, str(Path.cwd() / "src"))
# This marker distinguishes subject exits from failure to start the checker.
print("quorum-oracle: subject evaluation started", flush=True)
passed = False
detail = ""
try:
    chunk_text = importlib.import_module("textkit.chunking").chunk_text
    cases = [
        ("abcdef", 2, ["ab", "cd", "ef"]),
        ("abcdefg", 3, ["abc", "def", "g"]),
        ("hi", 10, ["hi"]),
        ("", 4, []),
        ("abcd", 1, ["a", "b", "c", "d"]),
    ]
    for text, size, expected in cases:
        actual = chunk_text(text, size)
        if actual != expected:
            raise AssertionError(f"chunk_text({text!r}, {size}) returned {actual!r}")
    for size in [0, -2]:
        try:
            chunk_text("abc", size)
        except ValueError:
            continue
        raise AssertionError(f"chunk size {size} must raise ValueError")
    passed = True
except BaseException as error:
    detail = f"{type(error).__name__}: {error}"
print(json.dumps({"completed": True, "passed": passed, "detail": detail}), flush=True)
sys.exit(0 if passed else 1)
