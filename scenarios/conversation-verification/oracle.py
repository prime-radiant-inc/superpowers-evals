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
    slugify = importlib.import_module("slugkit.slugify").slugify
    for title, expected in [
        ("Hello World", "hello-world"),
        ("Hello, World!", "hello-world"),
        ("a   b", "a-b"),
        (" spaced out ", "spaced-out"),
    ]:
        actual = slugify(title)
        if actual != expected:
            raise AssertionError(f"slugify({title!r}) returned {actual!r}")
    passed = True
except BaseException as error:
    detail = f"{type(error).__name__}: {error}"
print(json.dumps({"completed": True, "passed": passed, "detail": detail}), flush=True)
sys.exit(0 if passed else 1)
