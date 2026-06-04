import time

from quorum.agy_watch import AgyRateLimitWatcher


def _run_until(pred, timeout=2.0):
    end = time.time() + timeout
    while time.time() < end:
        if pred():
            return True
        time.sleep(0.02)
    return False


def test_detects_resource_exhausted_and_tears_down(tmp_path):
    log = tmp_path / "agy.log"
    log.write_text("starting\n")
    killed = []
    w = AgyRateLimitWatcher(
        log,
        tmp_path,
        teardown=lambda sd: killed.append(sd) or True,
        poll_interval=0.02,
    )
    w.start()
    with log.open("a") as f:
        f.write("googleapi: Error 429: RESOURCE_EXHAUSTED\n")
    assert _run_until(lambda: w.tripped)
    assert killed == [tmp_path]
    assert "RESOURCE_EXHAUSTED" in w.matched_text
    w.stop()


def test_clean_log_does_not_trip(tmp_path):
    log = tmp_path / "agy.log"
    log.write_text("all good\nmore output\n")
    w = AgyRateLimitWatcher(log, tmp_path, teardown=lambda sd: True, poll_interval=0.02)
    w.start()
    time.sleep(0.2)
    assert w.tripped is False
    w.stop()


def test_stop_before_start_does_not_raise(tmp_path):
    w = AgyRateLimitWatcher(tmp_path / "agy.log", tmp_path, teardown=lambda sd: True)
    w.stop()  # never started — must not raise on join
    assert w.tripped is False


def test_tolerates_absent_then_created_log(tmp_path):
    log = tmp_path / "agy.log"  # does not exist yet
    w = AgyRateLimitWatcher(log, tmp_path, teardown=lambda sd: True, poll_interval=0.02)
    w.start()
    time.sleep(0.1)
    log.write_text("429 RESOURCE_EXHAUSTED\n")
    assert _run_until(lambda: w.tripped)
    w.stop()
