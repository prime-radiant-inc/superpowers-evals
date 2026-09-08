"""The proposal task must preserve the actual seeded application page."""
import hashlib
import json
from pathlib import Path

# This digest is the page produced by create_cost_checkbox_page. Proposal
# documents may be added; the original application bytes must stay intact.
expected = "8dd8c4e4ca1bd3f8fe405dc195b6b8028128a98c198ce31e79836d928f213b4e"
print("quorum-oracle: subject evaluation started", flush=True)
passed = False
detail = ""
try:
    actual = hashlib.sha256(Path("index.html").read_bytes()).hexdigest()
    if actual != expected:
        raise AssertionError("application page changed before design agreement")
    passed = True
except Exception as error:
    detail = f"{type(error).__name__}: {error}"
print(json.dumps({"completed": True, "passed": passed, "detail": detail}), flush=True)
raise SystemExit(0 if passed else 1)
