#!/usr/bin/env bash
set -euo pipefail
# Self-contained fixture: a tiny textkit package with an off-by-one bug
# in chunk_text and a pytest file that catches it. No create_base_repo —
# this helper builds the whole repo.
uv run setup-helpers run create_claim_without_verification
