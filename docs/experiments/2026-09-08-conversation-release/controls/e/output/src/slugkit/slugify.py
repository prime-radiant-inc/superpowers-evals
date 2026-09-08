import re


def slugify(title: str) -> str:
    words = re.sub(r"[^a-z0-9\s-]", "", title.lower()).split()
    return "-".join(words)
