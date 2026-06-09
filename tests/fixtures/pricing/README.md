# Test-only obol pricing snapshot

Fixture data for the quorum test suite, applied via `OBOL_PRICING_DIR`
(see `tests/quorum/conftest.py`). The rates are frozen so cost
assertions are deterministic — they are NOT maintained as real pricing.
Real runs use obol's own resolution (embedded snapshot or a local
`obol refresh`). Add a model here only when a test needs it priced.
