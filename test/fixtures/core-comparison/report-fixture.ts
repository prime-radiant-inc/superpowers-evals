import {
  foldTransition,
  initialProjection,
} from '../../../src/campaign/execution-state.ts';
import type { AttemptEvidence } from '../../../src/campaign/report-evidence.ts';
import { CampaignTransitionSchema } from '../../../src/contracts/campaign/execution.ts';
import { ExperimentSchema } from '../../../src/contracts/campaign/experiment.ts';
import campaign from './campaign.json';
import evidenceJson from './evidence.json';
import expected from './expected-report.json';
import transitionsJson from './transitions.json';
export function mixedComparisonFixture() {
  const experiment = ExperimentSchema.parse(campaign);
  const transitions = transitionsJson.map((t) =>
    CampaignTransitionSchema.parse(t),
  );
  return {
    experiment,
    transitions,
    expected,
    state: transitions.reduce(foldTransition, initialProjection(experiment)),
    evidenceByAttempt: new Map(
      Object.entries(structuredClone(evidenceJson)) as [
        string,
        AttemptEvidence,
      ][],
    ),
    validityByBlock: new Map(
      ['c1-r1', 'c1-r2', 'c1-r3-reserve', 'c2-r1'].map((id) => [
        id,
        { available: true, reasons: [] as string[] },
      ]),
    ),
  };
}
