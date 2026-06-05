"""Regression tests for `_agy_log_shows_rate_limit`.

A live agy sentinel sweep (2026-06-05) false-tripped: the bare "429" substring
matched a hex trace ID in the streaming agy.log (`Trace: 0xfa48dee42910dc8f` →
"...e4291..."), so the mid-run watcher killed a perfectly healthy agy run. The
matcher must require a *real* rate-limit signal, not any "429" anywhere.
"""

from quorum.runner import _agy_log_shows_rate_limit

# Verbatim line from the false-positive run
# (results/triggering-test-driven-development-antigravity-20260605T054333Z-d12c).
_HEX_TRACE_LINE = (
    "I0604 22:43:45.882303 259 http_helpers.go:182] "
    "URL: https://daily-cloudcode-pa.googleapis.com/v1internal:loadCodeAssist "
    "Trace: 0xfa48dee42910dc8f"
)


def test_ignores_429_inside_a_hex_trace_id():
    assert _agy_log_shows_rate_limit(_HEX_TRACE_LINE) is False


def test_ignores_429_embedded_in_other_numbers():
    # ports, byte counts, etc. contain "429" without being a rate limit
    assert _agy_log_shows_rate_limit("Language server listening on port 14290") is False
    assert _agy_log_shows_rate_limit("read 4296 bytes from stream") is False


def test_fires_on_real_rate_limit_signals():
    assert _agy_log_shows_rate_limit("googleapi: Error 429: RESOURCE_EXHAUSTED") is True
    assert _agy_log_shows_rate_limit("HTTP status: 429 Too Many Requests") is True
    assert _agy_log_shows_rate_limit("rpc error RESOURCE_EXHAUSTED: quota") is True
    assert _agy_log_shows_rate_limit("backend returned RateLimitExceeded") is True


def test_clean_log_does_not_fire():
    assert _agy_log_shows_rate_limit("I0604 server.go:1292] Starting language server") is False
    assert _agy_log_shows_rate_limit("") is False
