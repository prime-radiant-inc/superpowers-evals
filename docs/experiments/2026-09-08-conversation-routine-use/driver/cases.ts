import { join } from 'node:path';

const brief = (name: string): string => join(import.meta.dir, 'briefs', `${name}.md`);

export const driverCases = [
  {
    id: 'preferences',
    briefPath: brief('preferences'),
    subjectCase: 'preferences',
    expectedCompletion: 'delivery',
  },
  {
    id: 'engineering',
    briefPath: brief('engineering'),
    subjectCase: 'engineering',
    expectedCompletion: 'delivery',
  },
  {
    id: 'authorization',
    briefPath: brief('authorization'),
    subjectCase: 'authorization',
    expectedCompletion: 'delivery',
  },
  {
    id: 'plan-delivery',
    briefPath: brief('plan-delivery'),
    subjectCase: 'plan-delivery',
    expectedCompletion: 'delivery',
  },
  {
    id: 'feedback-endpoint',
    briefPath: brief('feedback-endpoint'),
    subjectCase: 'feedback-endpoint',
    expectedCompletion: 'delivery',
  },
  {
    id: 'partial-refusal',
    briefPath: brief('partial-refusal'),
    subjectCase: 'partial-refusal',
    expectedCompletion: 'refusal',
  },
] as const satisfies readonly {
  id: string;
  briefPath: string;
  subjectCase: string;
  expectedCompletion: 'delivery' | 'refusal';
}[];
