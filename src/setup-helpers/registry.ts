// The dispatch table for `setup-helpers run <helper>`. Holds only the 37
// dispatchable (workdir-style) helpers; the two library-only entries
// addWorktree/detachHead are intentionally absent (no scenario dispatches them).
// KNOWN_HELPER_NAMES re-adds those two so `quorum check` validates against the
// full 39-name set.

import { createBaseRepo, recordHead } from './base.ts';
import {
  createClaimWithoutVerification,
  createCodeReviewPlantedBugs,
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
  scaffoldSddGoFractals,
  scaffoldSddGoFractalsCoarse,
  scaffoldSddGoFractalsControlPlan,
  scaffoldSddGoFractalsCrisp,
  scaffoldSddGoFractalsCriticalPlan,
  scaffoldSddGoFractalsElicited,
  scaffoldSddGoFractalsStripped,
  scaffoldSddQualityDefectPlan,
  scaffoldSddSpecConstraintPlan,
  scaffoldSddSvelteTodo,
  scaffoldSddSvelteTodoElicited,
  scaffoldSddYagniPlan,
} from './sdd-fixtures.ts';
import {
  addFlawedSpecForReview,
  createSpecTargetsWrongComponent,
  createSpecTargetsWrongComponentWithCheckpoint,
  createSpecWritingBlindSpot,
} from './spec-fixtures.ts';
import {
  addStubExecutingPlan,
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

export const REGISTRY: Record<string, RegistryEntry> = {
  create_base_repo: { fn: createBaseRepoHelper, needsTemplateDir: true },
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
  create_spec_targets_wrong_component: {
    fn: createSpecTargetsWrongComponent,
  },
  create_spec_targets_wrong_component_with_checkpoint: {
    fn: createSpecTargetsWrongComponentWithCheckpoint,
  },
  add_stub_executing_plan: { fn: addStubExecutingPlan },
  create_writing_plans_skeleton: { fn: createWritingPlansSkeleton },
  create_code_review_planted_bugs: { fn: createCodeReviewPlantedBugs },
  add_flawed_spec_for_review: { fn: addFlawedSpecForReview },
  add_sdd_auth_plan: { fn: addSddAuthPlan },
  scaffold_sdd_broken_plan: { fn: scaffoldSddBrokenPlan },
  scaffold_sdd_go_fractals: { fn: scaffoldSddGoFractals },
  scaffold_sdd_go_fractals_crisp: { fn: scaffoldSddGoFractalsCrisp },
  scaffold_sdd_go_fractals_coarse: { fn: scaffoldSddGoFractalsCoarse },
  scaffold_sdd_go_fractals_control_plan: {
    fn: scaffoldSddGoFractalsControlPlan,
  },
  scaffold_sdd_go_fractals_critical_plan: {
    fn: scaffoldSddGoFractalsCriticalPlan,
  },
  scaffold_sdd_go_fractals_elicited: { fn: scaffoldSddGoFractalsElicited },
  scaffold_sdd_go_fractals_stripped: { fn: scaffoldSddGoFractalsStripped },
  scaffold_sdd_svelte_todo: { fn: scaffoldSddSvelteTodo },
  scaffold_sdd_svelte_todo_elicited: { fn: scaffoldSddSvelteTodoElicited },
  scaffold_sdd_quality_defect_plan: { fn: scaffoldSddQualityDefectPlan },
  scaffold_sdd_spec_constraint_plan: { fn: scaffoldSddSpecConstraintPlan },
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

// The full Python HELPER_REGISTRY key set (39) — the 37 dispatchable plus the
// two library-only names. This is the validation set `quorum check` uses, so it
// must match Python's keys exactly (which include add_worktree/detach_head).
export const KNOWN_HELPER_NAMES: ReadonlySet<string> = new Set<string>([
  ...Object.keys(REGISTRY),
  'add_worktree',
  'detach_head',
]);
