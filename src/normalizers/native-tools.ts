// Tools the harness considers "native"; everything else is "shell". Global set,
// matches the Python NATIVE_TOOLS (quorum/normalizers.py). Shared by every dialect
// normalizer; membership is checked against the canonical (post-TOOL_MAP) name.
export const NATIVE_TOOLS: ReadonlySet<string> = new Set([
  'EnterWorktree',
  'ExitWorktree',
  'EnterPlanMode',
  'ExitPlanMode',
  'TaskCreate',
  'TaskUpdate',
  'TaskList',
  'TaskGet',
  'Skill',
  'Agent',
  'Read',
  'Write',
  'Edit',
  'Glob',
  'Grep',
]);

export function classifySource(tool: string): 'native' | 'shell' {
  return NATIVE_TOOLS.has(tool) ? 'native' : 'shell';
}
