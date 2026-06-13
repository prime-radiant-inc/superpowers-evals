# Vendored dashboard static assets

These files are vendored verbatim (byte-for-byte) — do not lint, format, or
hand-edit them. Biome excludes `src/dashboard/static/**` (see `biome.json`
`files.includes`). They are served as-is by the dashboard server from
`GET /static/*`.

## Provenance

Copied verbatim from the Python dashboard reference worktree
`.worktrees/dashboard-ref/quorum/dashboard/static/` (PRI-2185), which is the
authoritative source for the dashboard's appearance. The TS templates in
`../templates.ts` reproduce exactly the class names and `data-*` attributes
that `styles.css` and `app.js` couple on, so these assets work unchanged.

| File | Source | Notes |
|---|---|---|
| `htmx.min.js` | htmx **2.0.4** (minified) | Real release, not a placeholder. The `version:"2.0.4"` string is present in the bundle. |
| `htmx-ext-sse.js` | htmx Server-Sent-Events extension (matching 2.x) | The `hx-ext="sse"` + `sse-connect`/`sse-swap` wiring the layout/cell use. |
| `styles.css` | dashboard reference | Dark-theme tokens, grid/cell/ribbon/cost-bar/run-strip/hover-card styles. |
| `app.js` | dashboard reference | Hover-preview chip, confirm dialog, `data-launch` launch flow, `[data-card]` hover card, `.stop` → `POST /stop`. |
| `fonts/Inter-Regular.woff2` | Inter (OFL) | `@font-face` weight 400. |
| `fonts/Inter-SemiBold.woff2` | Inter (OFL) | `@font-face` weight 600. |
| `fonts/OFL.txt` | Inter license | SIL Open Font License. |

The reference's `htmx.min.js` and `htmx-ext-sse.js` were verified to be the
real minified bundles (50,917 and 8,896 bytes), so no fresh download was
needed — the verbatim copy is the vendored asset.
