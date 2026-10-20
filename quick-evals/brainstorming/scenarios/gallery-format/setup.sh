# Fixture: a small Flask + Pillow family photo gallery with a per-format
# registry (PNG, JPEG, GIF). Run with cwd = the scenario's work dir.
mkdir -p gallery templates tests
cat > gallery/__init__.py <<'PY'
PY
cat > gallery/formats.py <<'PY'
"""Image formats the gallery accepts.

Each format says how to recognise an upload, how to make its thumbnail, and
what Content-Type the original is served with. Browsers display every format
here natively, so originals are served as uploaded.
"""
from dataclasses import dataclass
from typing import Callable

from PIL import Image, ImageSequence

THUMB_SIZE = (320, 320)


def _still_thumbnail(src, dest):
    with Image.open(src) as im:
        im = im.convert("RGB")
        im.thumbnail(THUMB_SIZE)
        im.save(dest, "JPEG", quality=82)


def _gif_thumbnail(src, dest):
    # Animated GIFs: thumbnail the first frame only.
    with Image.open(src) as im:
        first = next(ImageSequence.Iterator(im)).convert("RGB")
        first.thumbnail(THUMB_SIZE)
        first.save(dest, "JPEG", quality=82)


@dataclass(frozen=True)
class Format:
    name: str
    extensions: tuple
    magic: bytes
    mimetype: str
    make_thumbnail: Callable


FORMATS = [
    Format("PNG", (".png",), b"\x89PNG", "image/png", _still_thumbnail),
    Format("JPEG", (".jpg", ".jpeg"), b"\xff\xd8\xff", "image/jpeg", _still_thumbnail),
    Format("GIF", (".gif",), b"GIF8", "image/gif", _gif_thumbnail),
]


def detect(filename, head):
    """Return the Format for an upload, or None if we don't accept it."""
    lower = filename.lower()
    for fmt in FORMATS:
        if lower.endswith(fmt.extensions) and head.startswith(fmt.magic):
            return fmt
    return None
PY
cat > gallery/app.py <<'PY'
import os
import uuid

from flask import Flask, abort, flash, redirect, render_template, request, send_from_directory, url_for

from gallery.formats import FORMATS, detect

app = Flask(__name__, template_folder="../templates")
app.secret_key = "dev"
MEDIA = os.environ.get("GALLERY_MEDIA", "media")
ORIGINALS = os.path.join(MEDIA, "originals")
THUMBS = os.path.join(MEDIA, "thumbs")


@app.route("/")
def index():
    photos = sorted(os.listdir(THUMBS)) if os.path.isdir(THUMBS) else []
    return render_template("index.html", photos=[p.rsplit(".", 1)[0] for p in photos])


@app.route("/upload", methods=["POST"])
def upload():
    f = request.files["photo"]
    head = f.stream.read(16)
    f.stream.seek(0)
    fmt = detect(f.filename, head)
    if fmt is None:
        accepted = ", ".join(x.name for x in FORMATS)
        flash(f"Sorry, we only accept {accepted}.")
        return redirect(url_for("index"))
    os.makedirs(ORIGINALS, exist_ok=True)
    os.makedirs(THUMBS, exist_ok=True)
    photo_id = uuid.uuid4().hex
    original = os.path.join(ORIGINALS, photo_id + fmt.extensions[0])
    f.save(original)
    fmt.make_thumbnail(original, os.path.join(THUMBS, photo_id + ".jpg"))
    return redirect(url_for("index"))


@app.route("/thumbs/<photo_id>.jpg")
def thumb(photo_id):
    return send_from_directory(os.path.abspath(THUMBS), photo_id + ".jpg")


@app.route("/photos/<photo_id>")
def original(photo_id):
    for name in os.listdir(ORIGINALS):
        if name.startswith(photo_id + "."):
            return send_from_directory(os.path.abspath(ORIGINALS), name)
    abort(404)
PY
cat > templates/index.html <<'HTML'
<!doctype html><html><head><title>Family Photos</title></head><body>
{% for m in get_flashed_messages() %}<p class="flash">{{ m }}</p>{% endfor %}
<form method="post" action="/upload" enctype="multipart/form-data">
  <input type="file" name="photo" accept=".png,.jpg,.jpeg,.gif"><button>Upload</button>
</form>
<div class="grid">{% for p in photos %}<a href="/photos/{{ p }}"><img src="/thumbs/{{ p }}.jpg" loading="lazy"></a>{% endfor %}</div>
</body></html>
HTML
: > tests/__init__.py
cat > tests/test_formats.py <<'PY'
import io
import unittest

from PIL import Image

from gallery.formats import detect


def encoded(fmt):
    buf = io.BytesIO()
    Image.new("RGB", (4, 4), "red").save(buf, fmt)
    return buf.getvalue()


class DetectTest(unittest.TestCase):
    def test_accepts_known_formats(self):
        self.assertEqual(detect("a.PNG", encoded("PNG")[:16]).name, "PNG")
        self.assertEqual(detect("a.jpeg", encoded("JPEG")[:16]).name, "JPEG")
        self.assertEqual(detect("a.gif", encoded("GIF")[:16]).name, "GIF")

    def test_rejects_mismatched_extension(self):
        self.assertIsNone(detect("a.png", encoded("JPEG")[:16]))
PY
cat > requirements.txt <<'TXT'
flask==3.1.*
pillow==11.*
TXT
cat > README.md <<'MD'
# Family Photos

A small gallery the family uploads photos to. `pip install -r requirements.txt`,
`flask --app gallery.app run`. Originals live in `media/originals`, JPEG
thumbnails in `media/thumbs`. Supported formats are listed in `gallery/formats.py`.
MD
git add -A && git -c user.email=t@t -c user.name=t commit -qm "family photo gallery"
