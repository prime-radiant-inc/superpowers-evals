import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { createDurableMarker } from '../campaign/journal.ts';

export type QualificationSession = {
  id: string;
  repetition: number;
  group: 'retained' | 'supplemental' | 'additional' | 'driver';
};
export type QualificationSettlement = {
  knownUsd: number;
  complete: boolean;
  semanticMatch: boolean;
  fault: string | null;
};
const marker = (path: string, value: unknown) =>
  createDurableMarker(path, `${JSON.stringify(value)}\n`);
/** The full fixed role set is diagnostic; only operational defects stop its serial admissions. */
export async function runQualificationSessions(d: {
  sessions: QualificationSession[];
  outputRoot: string;
  fits(): boolean;
  now(): number;
  stopped(): boolean;
  validate(): void;
  execute(
    session: QualificationSession,
    out: string,
  ): Promise<QualificationSettlement>;
}): Promise<QualificationSettlement & { consumed: number }> {
  const total = {
    knownUsd: 0,
    complete: true,
    semanticMatch: true,
    fault: null as string | null,
    consumed: 0,
  };
  for (const session of d.sessions) {
    const { id, repetition } = session;
    d.validate();
    if (d.stopped() || !d.fits()) {
      total.complete = false;
      total.fault = 'qualification admission stopped';
      return total;
    }
    const ordinal = total.consumed + 1;
    const out = join(d.outputRoot, String(ordinal).padStart(2, '0'));
    mkdirSync(out, { mode: 0o700 });
    marker(join(out, 'launch.json'), {
      ordinal,
      id,
      repetition,
      atMs: d.now(),
    });
    total.consumed++;
    let settled: QualificationSettlement;
    try {
      settled = await d.execute(session, out);
    } catch {
      settled = {
        knownUsd: 0,
        complete: false,
        semanticMatch: false,
        fault: 'role execution failed; inspect retained evidence',
      };
    }
    if (!Number.isFinite(settled.knownUsd) || settled.knownUsd < 0)
      throw new Error('invalid qualification subtotal');
    marker(join(out, 'settled.json'), { ordinal, ...settled, atMs: d.now() });
    total.knownUsd = Number(
      (total.knownUsd + settled.knownUsd).toPrecision(15),
    );
    total.semanticMatch &&= settled.semanticMatch;
    if (!settled.complete || settled.fault !== null) {
      total.complete = false;
      total.fault = settled.fault ?? 'incomplete role accounting';
      return total;
    }
  }
  return total;
}
