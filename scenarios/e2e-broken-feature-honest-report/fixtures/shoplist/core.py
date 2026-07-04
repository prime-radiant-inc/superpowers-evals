import json
from pathlib import Path

DATA_FILE = Path("data/items.json")


def load_items():
    return json.loads(DATA_FILE.read_text())


def save_items(items):
    DATA_FILE.write_text(json.dumps(items, indent=2) + "\n")


def add_item(items, name, price):
    items.append({"name": name, "price": float(price)})
    return items


def compute_total(items):
    return round(sum(i["price"] for i in items), 2)
