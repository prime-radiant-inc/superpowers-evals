import json
from pathlib import Path

DEFAULTS = {"retries": 3, "tracing": True}

def load_config(path, overrides=None):
    merged = {**DEFAULTS, **json.loads(Path(path).read_text()), **(overrides or {})}
    return {key: merged.get(key) or default for key, default in DEFAULTS.items()}
