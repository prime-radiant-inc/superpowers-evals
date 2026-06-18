// Harbor pin for the ported log→ATIF converters. Bump only after re-porting the
// affected normalizers and re-running their parity tests. See
// docs/superpowers/reference/porting-harbor-converters.md.
//
// `commit` is the global Harbor revision the source tree was last inspected at.
// `ported.<agent>` records the Harbor commit each normalizer was last ported
// from, so `git diff <ported.agent>..<commit>` is a scoped "what changed
// upstream for this converter" query when they drift apart.
//
// pi is intentionally absent: it has no Harbor converter and is
// reverse-engineered from pi's own captured log, not ported.

export const HARBOR_PIN = {
  repo: 'https://github.com/laude-institute/harbor',
  commit: '5352049de712613e58459cad41afcf0bf8645738',
  version: '0.14.0',
  ported: {
    // Upgraded to full-fidelity ATIF using Harbor's converters as reference.
    claude: '5352049de712613e58459cad41afcf0bf8645738',
    codex: '5352049de712613e58459cad41afcf0bf8645738',
    copilot: '5352049de712613e58459cad41afcf0bf8645738',
    gemini: '5352049de712613e58459cad41afcf0bf8645738',
    opencode: '5352049de712613e58459cad41afcf0bf8645738',
    kimi: '5352049de712613e58459cad41afcf0bf8645738',
    antigravity: '5352049de712613e58459cad41afcf0bf8645738',
    // Ported from Harbor's installed/<agent> converters.
    acp: '5352049de712613e58459cad41afcf0bf8645738',
    cline: '5352049de712613e58459cad41afcf0bf8645738',
    cursor: '5352049de712613e58459cad41afcf0bf8645738',
    goose: '5352049de712613e58459cad41afcf0bf8645738',
    hermes: '5352049de712613e58459cad41afcf0bf8645738',
    mimo: '5352049de712613e58459cad41afcf0bf8645738',
    'mini-swe': '5352049de712613e58459cad41afcf0bf8645738',
    openclaw: '5352049de712613e58459cad41afcf0bf8645738',
    openhands: '5352049de712613e58459cad41afcf0bf8645738',
    qwen: '5352049de712613e58459cad41afcf0bf8645738',
    'swe-agent': '5352049de712613e58459cad41afcf0bf8645738',
    trae: '5352049de712613e58459cad41afcf0bf8645738',
  },
} as const;
