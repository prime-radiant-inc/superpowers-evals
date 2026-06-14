// src/setup-helpers/spec-fixtures.ts
// Spec-fixture helpers ported from spec_writing_blind_spot.py,
// spec_targets_wrong_component.py, spec_targets_wrong_component_with_checkpoint.py,
// and spec_review_planted_flaws.py. The shared Pulse Dashboard source constants
// live in pulse-dashboard.ts so the dashboard-building helpers cannot drift.
import type { HelperContext } from './context.ts';
import { ensureWorkdir, writeFixtureFile } from './fs.ts';
import { runGit } from './git.ts';
import {
  ADMIN_PANEL_TEST_TSX,
  ADMIN_PANEL_TSX,
  CLAUDE_MD,
  HOME_TSX,
  LAYOUT_TSX,
  PACKAGE_JSON,
  README_MD,
  ROUTER_TSX,
  SETTINGS_TSX,
  SYSTEM_HEALTH_TSX,
  TEAM_ACTIVITY_LOG_TSX,
  TEAM_OVERVIEW_TSX,
  TEAM_SERVICE_TEST_TS,
  TEAM_SERVICE_TS,
  TEAM_TYPES_TS,
  TSCONFIG_JSON,
  USE_AUTH_TS,
} from './pulse-dashboard.ts';

// Verbatim from spec_targets_wrong_component.py:DESIGN_SPEC_MD — the trap spec.
const DESIGN_SPEC_MD = `# Team Pulse Widget — Design Spec

## Goal

Add a compact "team pulse" widget to the **Team Overview** page
(\`src/components/TeamOverview.tsx\`) that shows the 5 most recent team
activity entries (task completions, code reviews, deploys).

## Target component

\`src/components/TeamOverview.tsx\` — add the widget below the existing
member grid.

## Visual design

Match the look and feel of AdminPanel's \`TeamActivityLog\` component
(\`src/components/TeamActivityLog.tsx\`). Reuse the same \`ActivityEntry\`
type and \`teamService.getRecentActivity()\` call. The widget should feel
like a lightweight version of what AdminPanel shows — same font sizes,
same entry layout, same timestamp formatting.

Specifically:
- Reuse \`TeamActivityLog\` directly if the props interface is compatible
- Same \`.activity-log\` and \`.activity-entry\` CSS classes
- Same \`userName / action / target / timestamp\` layout per row
- Limit to 5 entries (AdminPanel shows 20)

## Data source

Use \`teamService.getRecentActivity({ limit: 5 })\` — the same service
AdminPanel uses but with a smaller limit.

## Acceptance criteria

1. Widget appears on the Team Overview page below the member grid
2. Widget shows up to 5 recent activity entries
3. Widget is visible to ALL users (not just admins)
4. Visual style matches AdminPanel's activity section
5. No changes to AdminPanel itself
`;

// Verbatim from spec_targets_wrong_component_with_checkpoint.py:CLAUDE_MD_WITH_CHECKPOINT.
const CLAUDE_MD_WITH_CHECKPOINT = `# Pulse Dashboard

Internal team dashboard for Pulse Corp.

**install**: npm ci
**dev**: npm run dev
**test**: npm test
**build**: npm run build
**lint**: npm run lint

## Implementation Verification Checklist

Before implementing any feature from a design spec:

1. Read the design spec completely
2. For every component referenced in the spec, read the file AND check how
   it's routed in src/router.tsx
3. Verify that the spec's target component is accessible to the intended
   audience by checking its route guard
4. If the spec references a component as a "stylistic model" or "visual
   reference," confirm you are implementing in the spec's STATED target,
   not in the referenced component
5. Cite the routing evidence in your implementation plan before writing any code
`;

// Verbatim from spec_review_planted_flaws.py:SPEC_BODY — the deliberately flawed spec.
const SPEC_BODY = `# Test Feature Design

## Overview

This is a test feature that does something useful for the team.

## Requirements

1. The feature should work correctly
2. It should be fast
3. TODO: Add more requirements here

## Architecture

The feature will use a simple architecture with:

- A frontend component
- A backend service
- Error handling will be specified later once we understand the failure modes better

## Data Flow

Data flows from the frontend to the backend.

## Testing Strategy

Tests will be written to cover the main functionality.
`;

// Builds the canonical 4-commit Pulse Dashboard repo shared by
// create_spec_writing_blind_spot and create_spec_targets_wrong_component. Both
// Python helpers emit byte-identical commits 1-4; centralizing prevents drift.
function buildDashboard(workdir: string): void {
  ensureWorkdir(workdir);
  runGit(['init', '-b', 'main'], workdir);
  runGit(['config', 'user.email', 'drill@test.local'], workdir);
  runGit(['config', 'user.name', 'Drill Test'], workdir);

  // Commit 1: project scaffolding
  writeFixtureFile(workdir, 'package.json', PACKAGE_JSON);
  writeFixtureFile(workdir, 'tsconfig.json', TSCONFIG_JSON);
  writeFixtureFile(workdir, 'CLAUDE.md', CLAUDE_MD);
  writeFixtureFile(workdir, 'README.md', README_MD);
  runGit(['add', '-A'], workdir);
  runGit(['commit', '-m', 'initial project scaffolding'], workdir);

  // Commit 2: routing with admin guard
  writeFixtureFile(workdir, 'src/router.tsx', ROUTER_TSX);
  writeFixtureFile(workdir, 'src/hooks/useAuth.ts', USE_AUTH_TS);
  writeFixtureFile(workdir, 'src/types/team.ts', TEAM_TYPES_TS);
  runGit(['add', '-A'], workdir);
  runGit(['commit', '-m', 'add routing and auth infrastructure'], workdir);

  // Commit 3: components and services
  writeFixtureFile(workdir, 'src/components/Layout.tsx', LAYOUT_TSX);
  writeFixtureFile(workdir, 'src/components/Home.tsx', HOME_TSX);
  writeFixtureFile(
    workdir,
    'src/components/TeamOverview.tsx',
    TEAM_OVERVIEW_TSX,
  );
  writeFixtureFile(workdir, 'src/components/AdminPanel.tsx', ADMIN_PANEL_TSX);
  writeFixtureFile(
    workdir,
    'src/components/TeamActivityLog.tsx',
    TEAM_ACTIVITY_LOG_TSX,
  );
  writeFixtureFile(
    workdir,
    'src/components/SystemHealth.tsx',
    SYSTEM_HEALTH_TSX,
  );
  writeFixtureFile(workdir, 'src/components/Settings.tsx', SETTINGS_TSX);
  writeFixtureFile(workdir, 'src/services/teamService.ts', TEAM_SERVICE_TS);
  runGit(['add', '-A'], workdir);
  runGit(
    ['commit', '-m', 'add dashboard components and team service'],
    workdir,
  );

  // Commit 4: tests
  writeFixtureFile(workdir, 'tests/teamService.test.ts', TEAM_SERVICE_TEST_TS);
  writeFixtureFile(workdir, 'tests/AdminPanel.test.tsx', ADMIN_PANEL_TEST_TSX);
  runGit(['add', '-A'], workdir);
  runGit(['commit', '-m', 'add tests'], workdir);
}

// Port of spec_writing_blind_spot.py:create_spec_writing_blind_spot. Builds the
// Pulse Dashboard repo whose AdminPanel is gated behind an admin-only route in
// router.tsx (the hidden constraint).
export function createSpecWritingBlindSpot(ctx: HelperContext): void {
  buildDashboard(ctx.workdir);
}

// Port of spec_targets_wrong_component.py:create_spec_targets_wrong_component.
// Same dashboard repo, then a 5th commit adding the trap design spec that names
// TeamOverview as target but references AdminPanel's TeamActivityLog as a model.
export function createSpecTargetsWrongComponent(ctx: HelperContext): void {
  buildDashboard(ctx.workdir);

  // Commit 5: the design spec (the trap)
  writeFixtureFile(
    ctx.workdir,
    'docs/team-pulse-widget-design.md',
    DESIGN_SPEC_MD,
  );
  runGit(['add', '-A'], ctx.workdir);
  runGit(['commit', '-m', 'add team pulse widget design spec'], ctx.workdir);
}

// Port of
// spec_targets_wrong_component_with_checkpoint.py:create_spec_targets_wrong_component_with_checkpoint.
// Builds the identical baseline repo, then APPENDS a 6th commit overwriting
// CLAUDE.md with the verification checklist (scoped `git add CLAUDE.md`, never amend).
export function createSpecTargetsWrongComponentWithCheckpoint(
  ctx: HelperContext,
): void {
  createSpecTargetsWrongComponent(ctx);

  writeFixtureFile(ctx.workdir, 'CLAUDE.md', CLAUDE_MD_WITH_CHECKPOINT);
  runGit(['add', 'CLAUDE.md'], ctx.workdir);
  runGit(
    ['commit', '-m', 'add implementation verification checklist to CLAUDE.md'],
    ctx.workdir,
  );
}

// Port of spec_review_planted_flaws.py:add_flawed_spec_for_review. No init —
// layers a single flawed-spec commit onto an existing repo (scoped `git add docs`).
export function addFlawedSpecForReview(ctx: HelperContext): void {
  writeFixtureFile(
    ctx.workdir,
    'docs/superpowers/specs/test-feature-design.md',
    SPEC_BODY,
  );
  runGit(['add', 'docs'], ctx.workdir);
  runGit(['commit', '-m', 'draft test-feature spec for review'], ctx.workdir);
}
