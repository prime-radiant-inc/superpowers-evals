#!/usr/bin/env bash
set -euo pipefail
setup-helpers run create_base_repo

# Spec-location override (guards real issue #939: brainstorming hardcodes
# docs/superpowers/specs/ and ignores a CLAUDE.md path override). MULTI-TURN: the
# agent must reach the spec-write to test this.
inject-user-preference "Project convention: write ALL design specs and plans under docs/specs/ (for example docs/specs/url-shortener-design.md). Do NOT use docs/superpowers/specs/ or docs/superpowers/plans/ — keep design docs in docs/specs/."
