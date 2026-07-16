// The dispatch table for `setup-helpers run <helper>`. Holds only the
// dispatchable (workdir-style) helpers; the two library-only entries
// addWorktree/detachHead are intentionally absent (no scenario dispatches them).
// KNOWN_HELPER_NAMES re-adds those two so `quorum check` validates against the
// full set.

import { join } from 'node:path';
import { createBaseRepo, initRepoFromFixtures, recordHead } from './base.ts';
import {
  createClaimWithoutVerification,
  createCodeReviewPlantedBugs,
  createFinishingBranchWorktree,
  createPhantomCompletion,
  createReviewPushback,
} from './behavior-fixtures.ts';
import type { Helper, HelperContext } from './context.ts';
import {
  createCostCheckboxPage,
  createCostCleanRepo,
  createCostLargeFiles,
  createCostTrivialPlan,
} from './cost-fixtures.ts';
import {
  addSddAuthPlan,
  scaffoldSddBrokenPlan,
  scaffoldSddQualityDefectPlan,
  scaffoldSddSamePlanResume,
  scaffoldSddSpecConstraintPlan,
  scaffoldSddStaleForeignWorkspace,
  scaffoldSddYagniPlan,
} from './sdd-fixtures.ts';
import {
  addFlawedSpecForReview,
  createSpecTargetsWrongComponent,
  createSpecWritingBlindSpot,
} from './spec-fixtures.ts';
import {
  addAuthExecutionPlan,
  createWritingPlansSkeleton,
} from './triggering-fixtures.ts';
import {
  addExistingWorktree,
  createCallerConsentPlan,
  detachWorktreeHead,
  installCodexSuperpowersPluginHooks,
  linkGeminiExtension,
  setupPressureWorktreeConditions,
  symlinkSuperpowers,
} from './worktree.ts';

export interface RegistryEntry {
  readonly fn: Helper;
  readonly needsTemplateDir?: boolean;
  readonly needsSuperpowersRoot?: boolean;
  readonly needsScenarioDir?: boolean;
}

// createBaseRepo/recordHead have non-HelperContext signatures; wrap them as thin
// Helper adapters so they fit the uniform dispatch contract. The base-repo
// adapter throws when templateDir is unfilled (parity with the CLI requiring
// QUORUM_REPO_ROOT for a needsTemplateDir helper).
const createBaseRepoHelper: Helper = (c: HelperContext): void => {
  if (c.templateDir === undefined) {
    throw new Error('templateDir is required for create_base_repo');
  }
  createBaseRepo(c.workdir, c.templateDir);
};

const recordHeadHelper: Helper = (c: HelperContext): void => {
  recordHead(c.workdir);
};

// scenarioDir is filled by runHelpers for needsScenarioDir helpers; the guard is
// parity with createBaseRepoHelper's templateDir check.
const initRepoFromFixturesHelper: Helper = (c: HelperContext): void => {
  if (c.scenarioDir === undefined) {
    throw new Error('scenarioDir is required for init_repo_from_fixtures');
  }
  initRepoFromFixtures(c.workdir, join(c.scenarioDir, 'fixtures'));
};

export const REGISTRY: Record<string, RegistryEntry> = {
  create_base_repo: { fn: createBaseRepoHelper, needsTemplateDir: true },
  init_repo_from_fixtures: {
    fn: initRepoFromFixturesHelper,
    needsScenarioDir: true,
  },
  symlink_superpowers: { fn: symlinkSuperpowers, needsSuperpowersRoot: true },
  install_codex_superpowers_plugin_hooks: {
    fn: installCodexSuperpowersPluginHooks,
    needsSuperpowersRoot: true,
  },
  add_existing_worktree: { fn: addExistingWorktree },
  detach_worktree_head: { fn: detachWorktreeHead },
  link_gemini_extension: {
    fn: linkGeminiExtension,
    needsSuperpowersRoot: true,
  },
  create_caller_consent_plan: { fn: createCallerConsentPlan },
  create_spec_writing_blind_spot: { fn: createSpecWritingBlindSpot },
  create_claim_without_verification: { fn: createClaimWithoutVerification },
  create_phantom_completion: { fn: createPhantomCompletion },
  create_review_pushback: { fn: createReviewPushback },
  create_finishing_branch_worktree: { fn: createFinishingBranchWorktree },
  create_spec_targets_wrong_component: {
    fn: createSpecTargetsWrongComponent,
  },
  add_auth_execution_plan: { fn: addAuthExecutionPlan },
  create_writing_plans_skeleton: { fn: createWritingPlansSkeleton },
  create_code_review_planted_bugs: { fn: createCodeReviewPlantedBugs },
  add_flawed_spec_for_review: { fn: addFlawedSpecForReview },
  add_sdd_auth_plan: { fn: addSddAuthPlan },
  scaffold_sdd_broken_plan: { fn: scaffoldSddBrokenPlan },
  scaffold_sdd_quality_defect_plan: { fn: scaffoldSddQualityDefectPlan },
  scaffold_sdd_same_plan_resume: { fn: scaffoldSddSamePlanResume },
  scaffold_sdd_spec_constraint_plan: { fn: scaffoldSddSpecConstraintPlan },
  scaffold_sdd_stale_foreign_workspace: {
    fn: scaffoldSddStaleForeignWorkspace,
  },
  scaffold_sdd_yagni_plan: { fn: scaffoldSddYagniPlan },
  setup_pressure_worktree_conditions: {
    fn: setupPressureWorktreeConditions,
  },
  create_cost_checkbox_page: { fn: createCostCheckboxPage },
  create_cost_clean_repo: { fn: createCostCleanRepo },
  create_cost_trivial_plan: { fn: createCostTrivialPlan },
  create_cost_large_files: { fn: createCostLargeFiles },
  record_head: { fn: recordHeadHelper },
};

// The full helper-name set. This is the validation set `quorum check` uses;
// includes the two library-only names (add_worktree/detach_head) absent from REGISTRY.
export const KNOWN_HELPER_NAMES: ReadonlySet<string> = new Set<string>([
  ...Object.keys(REGISTRY),
  'add_worktree',
  'detach_head',
]);
