from setup_helpers.base import create_base_repo, record_head
from setup_helpers.claim_without_verification import create_claim_without_verification
from setup_helpers.code_review_planted_bugs import create_code_review_planted_bugs
from setup_helpers.cost_checkbox_page import create_cost_checkbox_page
from setup_helpers.cost_clean_repo import create_cost_clean_repo
from setup_helpers.cost_large_files import create_cost_large_files
from setup_helpers.cost_trivial_plan import create_cost_trivial_plan
from setup_helpers.phantom_completion import create_phantom_completion
from setup_helpers.review_pushback import create_review_pushback
from setup_helpers.sdd_auth_plan import add_sdd_auth_plan
from setup_helpers.sdd_broken_plan import scaffold_sdd_broken_plan
from setup_helpers.sdd_quality_defect_plan import scaffold_sdd_quality_defect_plan
from setup_helpers.sdd_real_projects import (
    scaffold_sdd_go_fractals,
    scaffold_sdd_go_fractals_coarse,
    scaffold_sdd_go_fractals_control_plan,
    scaffold_sdd_go_fractals_crisp,
    scaffold_sdd_go_fractals_critical_plan,
    scaffold_sdd_go_fractals_elicited,
    scaffold_sdd_go_fractals_stripped,
    scaffold_sdd_svelte_todo,
    scaffold_sdd_svelte_todo_elicited,
)
from setup_helpers.sdd_spec_constraint_plan import scaffold_sdd_spec_constraint_plan
from setup_helpers.sdd_yagni_plan import scaffold_sdd_yagni_plan
from setup_helpers.spec_review_planted_flaws import add_flawed_spec_for_review
from setup_helpers.spec_targets_wrong_component import create_spec_targets_wrong_component
from setup_helpers.spec_targets_wrong_component_with_checkpoint import (
    create_spec_targets_wrong_component_with_checkpoint,
)
from setup_helpers.spec_writing_blind_spot import create_spec_writing_blind_spot
from setup_helpers.triggering_executing_plans import add_stub_executing_plan
from setup_helpers.triggering_writing_plans import create_writing_plans_skeleton
from setup_helpers.worktree import (
    add_existing_worktree,
    add_worktree,
    create_caller_consent_plan,
    detach_worktree_head,
    install_codex_superpowers_plugin_hooks,
    symlink_superpowers,
)
from setup_helpers.worktree_pressure import setup_pressure_worktree_conditions

HELPER_REGISTRY = {
    "create_base_repo": create_base_repo,
    "add_worktree": add_worktree,
    "symlink_superpowers": symlink_superpowers,
    "install_codex_superpowers_plugin_hooks": install_codex_superpowers_plugin_hooks,
    "add_existing_worktree": add_existing_worktree,
    "detach_worktree_head": detach_worktree_head,
    "create_caller_consent_plan": create_caller_consent_plan,
    "create_spec_writing_blind_spot": create_spec_writing_blind_spot,
    "create_claim_without_verification": create_claim_without_verification,
    "create_phantom_completion": create_phantom_completion,
    "create_review_pushback": create_review_pushback,
    "create_spec_targets_wrong_component": create_spec_targets_wrong_component,
    "create_spec_targets_wrong_component_with_checkpoint": (
        create_spec_targets_wrong_component_with_checkpoint
    ),
    "add_stub_executing_plan": add_stub_executing_plan,
    "create_writing_plans_skeleton": create_writing_plans_skeleton,
    "create_code_review_planted_bugs": create_code_review_planted_bugs,
    "add_flawed_spec_for_review": add_flawed_spec_for_review,
    "add_sdd_auth_plan": add_sdd_auth_plan,
    "scaffold_sdd_broken_plan": scaffold_sdd_broken_plan,
    "scaffold_sdd_go_fractals": scaffold_sdd_go_fractals,
    "scaffold_sdd_go_fractals_crisp": scaffold_sdd_go_fractals_crisp,
    "scaffold_sdd_go_fractals_coarse": scaffold_sdd_go_fractals_coarse,
    "scaffold_sdd_go_fractals_control_plan": scaffold_sdd_go_fractals_control_plan,
    "scaffold_sdd_go_fractals_critical_plan": scaffold_sdd_go_fractals_critical_plan,
    "scaffold_sdd_go_fractals_elicited": scaffold_sdd_go_fractals_elicited,
    "scaffold_sdd_go_fractals_stripped": scaffold_sdd_go_fractals_stripped,
    "scaffold_sdd_svelte_todo": scaffold_sdd_svelte_todo,
    "scaffold_sdd_svelte_todo_elicited": scaffold_sdd_svelte_todo_elicited,
    "scaffold_sdd_quality_defect_plan": scaffold_sdd_quality_defect_plan,
    "scaffold_sdd_spec_constraint_plan": scaffold_sdd_spec_constraint_plan,
    "scaffold_sdd_yagni_plan": scaffold_sdd_yagni_plan,
    "setup_pressure_worktree_conditions": setup_pressure_worktree_conditions,
    "create_cost_checkbox_page": create_cost_checkbox_page,
    "create_cost_clean_repo": create_cost_clean_repo,
    "create_cost_trivial_plan": create_cost_trivial_plan,
    "create_cost_large_files": create_cost_large_files,
    "record_head": record_head,
}
