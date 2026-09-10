import { join } from 'node:path';
import { driverCases as priorCases } from '../../2026-09-08-conversation-routine-use/driver/cases.ts';

// Six situations, two declared repetitions each. The existing subject sequence
// contains both narrow and broad preference questions; it is never retried to pass.
export const driverCases = priorCases.map((c) =>
  c.id === 'preferences'
    ? { ...c, briefPath: join(import.meta.dir, 'briefs/preferences.md') }
    : c,
);

export type PreferenceFact =
  | 'in-page'
  | 'selective-notifications'
  | 'local-browser'
  | 'task-population'
  | 'all-tasks';
export type PreferenceQuestion =
  | 'channel'
  | 'remaining-preferences'
  | 'notification-scope'
  | 'task-population'
  | 'offered-all-tasks'
  | 'delivery';
export type PreferenceAct = {
  kind: 'answer' | 'stop';
  facts: readonly PreferenceFact[];
  declinedInconsistentOption?: boolean;
};
// Caller-only oracle over reviewed acts, never a prompt-matching driver or an
// automatic classifier of natural language. It does not establish model behavior.
export function preferenceActAllowed(
  question: PreferenceQuestion,
  act: PreferenceAct,
): boolean {
  if (question === 'delivery')
    return act.kind === 'stop' && act.facts.length === 0;
  if (act.kind !== 'answer' || act.facts.includes('all-tasks')) return false;
  switch (question) {
    case 'channel':
      return act.facts.includes('in-page');
    case 'notification-scope':
      return act.facts.includes('selective-notifications');
    case 'remaining-preferences':
      return (
        ['in-page', 'selective-notifications', 'local-browser'] as const
      ).every((fact) => act.facts.includes(fact));
    case 'task-population':
      return act.facts.includes('task-population');
    case 'offered-all-tasks':
      return (
        act.declinedInconsistentOption === true &&
        act.facts.includes('selective-notifications')
      );
  }
}
