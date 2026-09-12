# Dashboard Design

## Design Lock

**Fidelity:** Match the approved screenshot as rendered.

**Authoritative sources:** `STYLE.md` and `config/design-tokens.json`.

| Screen | State | Theme | Viewport | PNG pixels | Artifact | Capture |
|---|---|---|---|---|---|---|
| Dashboard | default | light | 1440x900 | 1360x820 | `docs/superpowers/specs/assets/dashboard/dashboard--default--1440x900.png` | Playwright MCP / Chromium |
| Dashboard | navigation-open | light | 390x844 | 390x844 | `docs/superpowers/specs/assets/dashboard/dashboard--navigation-open--390x844.png` | Playwright MCP / Chromium |

Load-bearing properties:

- Fixed 280px left navigation.
- Three-column summary grid above 1100px.
- Below 600px the navigation becomes a 320px overlay; its open state is
  represented by the required mobile screenshot.
- Primary action uses the `brand.action` token.

The saved PNG was reviewed and approved.
