from dataclasses import dataclass, field
from datetime import datetime
from zoneinfo import ZoneInfo

WIDTH = 72


@dataclass
class Digest:
    recipient: str
    tz: str
    items: list = field(default_factory=list)
    send_at: datetime | None = None


def format_item(item, tz):
    when = item["at"].astimezone(ZoneInfo(tz)).strftime("%H:%M")
    line = f"{when}  {item['title']}"
    return line[:WIDTH]


def render(digest):
    subject = f"Your digest for {digest.send_at.astimezone(ZoneInfo(digest.tz)):%A}"
    lines = [format_item(item, digest.tz) for item in digest.items]
    return "\n".join([subject, ""] + lines)
