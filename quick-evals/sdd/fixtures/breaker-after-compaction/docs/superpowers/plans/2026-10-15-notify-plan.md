# Notification digest plan

## Global Constraints

- Digest emails are plain text, at most 72 columns wide.
- Times are shown in the recipient's time zone.

## Task 1: Digest model
Create `src/digest.py` with a `Digest` dataclass holding recipient, items, and send time.

## Task 2: Item formatting
Add `format_item(item, tz)` to `src/digest.py`: one line per item, `HH:MM  title`, wrapped at 72 columns.

## Task 3: Digest rendering
Add `render(digest)` to `src/digest.py`: a subject line, a blank line, then every item via `format_item`, in the recipient's time zone. Tests in `tests/test_render.py`.

## Task 4: Send hook
Call `render` from `src/send.py` and pass the result to the mailer.
