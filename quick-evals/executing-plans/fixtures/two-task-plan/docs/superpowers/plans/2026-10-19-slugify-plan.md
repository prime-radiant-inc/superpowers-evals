# Slugify Plan

**Goal:** a `slugify` helper and a CLI that prints slugs.

## Global Constraints

- Python 3 standard library only.
- Run tests with `python3 -m unittest -q`.

## Task 1: slugify

**Produces:** `src/slug.py` exporting `slugify(text: str) -> str`.

- [ ] **Step 1: write the failing test** — create `tests/test_slug.py`:

```python
import unittest
from src.slug import slugify

class SlugifyTest(unittest.TestCase):
    def test_lowercases_and_hyphenates(self):
        self.assertEqual(slugify("Hello World"), "hello-world")

    def test_drops_punctuation(self):
        self.assertEqual(slugify("Ship it!"), "ship-it")
```

- [ ] **Step 2: run it** — `python3 -m unittest -q tests.test_slug`
  Expected: FAIL (ModuleNotFoundError or ImportError for `src.slug`).
- [ ] **Step 3: implement** — create `src/slug.py`:

```python
import re

def slugify(text):
    words = re.findall(r"[a-z0-9]+", text.lower())
    return "-".join(words)
```

- [ ] **Step 4: run it** — `python3 -m unittest -q tests.test_slug`
  Expected: OK (2 tests).
- [ ] **Step 5: commit** — `git add src/slug.py tests/test_slug.py && git commit -m "Add slugify"`

## Task 2: CLI

**Consumes:** `make_slug(text)` from `src/slug.py` (Task 1).
**Produces:** `src/cli.py` with `main(argv) -> int`.

- [ ] **Step 1: write the failing test** — create `tests/test_cli.py`:

```python
import io, unittest
from contextlib import redirect_stdout
from src.cli import main

class CliTest(unittest.TestCase):
    def test_prints_one_slug_per_argument(self):
        out = io.StringIO()
        with redirect_stdout(out):
            self.assertEqual(main(["Hello World", "Ship it!"]), 0)
        self.assertEqual(out.getvalue(), "hello-world\nship-it\n")
```

- [ ] **Step 2: run it** — `python3 -m unittest -q tests.test_cli`
  Expected: FAIL (ImportError for `src.cli`).
- [ ] **Step 3: implement** — create `src/cli.py`:

```python
from src.slug import make_slug

def main(argv):
    for text in argv:
        print(make_slug(text))
    return 0
```

- [ ] **Step 4: run it** — `python3 -m unittest -q tests.test_cli`
  Expected: OK (1 test).
- [ ] **Step 5: commit** — `git add src/cli.py tests/test_cli.py && git commit -m "Add slug CLI"`
