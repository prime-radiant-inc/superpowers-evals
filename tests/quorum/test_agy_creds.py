import json

from quorum.agy_creds import backup_credential


def _write(p, obj):
    p.write_text(json.dumps(obj))


def test_corrupt_creds_restored(tmp_path, monkeypatch):
    creds = tmp_path / ".gemini" / "oauth_creds.json"
    creds.parent.mkdir(parents=True)
    _write(creds, {"access_token": "good", "refresh_token": "r"})
    monkeypatch.setattr("quorum.agy_creds._CRED_PATH", creds)
    b = backup_credential()
    creds.write_text('{"access_token": "tru')  # simulate half-written kill
    b.verify_or_restore()
    assert json.loads(creds.read_text())["access_token"] == "good"  # restored


def test_legitimate_refresh_not_restored(tmp_path, monkeypatch):
    creds = tmp_path / ".gemini" / "oauth_creds.json"
    creds.parent.mkdir(parents=True)
    _write(creds, {"access_token": "old", "refresh_token": "r"})
    monkeypatch.setattr("quorum.agy_creds._CRED_PATH", creds)
    b = backup_credential()
    _write(creds, {"access_token": "rotated", "refresh_token": "r"})  # valid refresh
    b.verify_or_restore()
    assert json.loads(creds.read_text())["access_token"] == "rotated"  # left alone


def test_missing_creds_is_noop(tmp_path, monkeypatch):
    monkeypatch.setattr("quorum.agy_creds._CRED_PATH", tmp_path / "nope.json")
    assert backup_credential() is None  # nothing to protect; caller no-ops


def test_backup_file_cleaned_up_on_valid_json(tmp_path, monkeypatch):
    creds = tmp_path / ".gemini" / "oauth_creds.json"
    creds.parent.mkdir(parents=True)
    _write(creds, {"access_token": "ok", "refresh_token": "r"})
    monkeypatch.setattr("quorum.agy_creds._CRED_PATH", creds)
    b = backup_credential()
    backup_path = b.backup
    assert backup_path.exists()
    b.verify_or_restore()
    assert not backup_path.exists()  # temp file removed even on no-op path


def test_backup_file_cleaned_up_after_restore(tmp_path, monkeypatch):
    creds = tmp_path / ".gemini" / "oauth_creds.json"
    creds.parent.mkdir(parents=True)
    _write(creds, {"access_token": "good", "refresh_token": "r"})
    monkeypatch.setattr("quorum.agy_creds._CRED_PATH", creds)
    b = backup_credential()
    backup_path = b.backup
    creds.write_text("not json at all")
    b.verify_or_restore()
    assert not backup_path.exists()  # temp file removed after restore
