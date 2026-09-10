import json
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parents[1] / "src"))

from configkit.loader import load_config


class LoadConfigTest(unittest.TestCase):
    def load(self, values, overrides=None):
        with tempfile.TemporaryDirectory() as root:
            path = Path(root) / "config.json"
            path.write_text(json.dumps(values))
            return load_config(path, overrides)

    def test_file_values_replace_defaults(self):
        self.assertEqual(
            self.load({"retries": 5, "tracing": False}),
            {"retries": 5, "tracing": False},
        )

    def test_zero_disables_retries(self):
        self.assertEqual(
            self.load({"retries": 0}),
            {"retries": 0, "tracing": True},
        )

    def test_explicit_overrides_take_precedence(self):
        self.assertEqual(
            self.load({"retries": 5, "tracing": True}, {"retries": 1, "tracing": False}),
            {"retries": 1, "tracing": False},
        )


if __name__ == "__main__":
    unittest.main()
