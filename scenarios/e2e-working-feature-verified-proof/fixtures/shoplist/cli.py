import sys

from shoplist.core import add_item, load_items, save_items
from shoplist.render import render_table


def main():
    argv = sys.argv[1:]
    if not argv or argv[0] not in {"add", "show"}:
        print("usage: shoplist add <name> <price> | shoplist show")
        return 1
    items = load_items()
    if argv[0] == "add":
        save_items(add_item(items, argv[1], argv[2]))
        print(f"added {argv[1]}")
        return 0
    for line in render_table(items):
        print(line)
    return 0
