// Same-tree redundancy adjudication.
//
// Re-running a suite is not automatically waste. It is waste only when nothing
// could have changed the answer since the last run of that same suite. So the
// adjudication needs a single timeline across ALL threads in the run — a
// reviewer's suite run is redundant with respect to the IMPLEMENTER's run that
// preceded it, not just with respect to its own thread.
//
// LIMITATION, and it is a real one: a patch event is a PROXY for tree mutation.
// We see apply_patch / Edit / Write, and we do not see git checkouts, branch
// switches, merges, stashes, `npm install`, or a sibling worktree being created
// — all of which change what a suite would report. So `redundant: true` means
// "no recorded file mutation since the previous run of this family", which is
// necessary but not sufficient for actual waste. Treat it as an upper bound and
// read the raw counts alongside it. The CLI prints this caveat.

import type { ParsedThread } from './thread.ts';
import type { SeatEvent } from './types.ts';

interface TimelineEntry {
  readonly seatIndex: number;
  readonly eventIndex: number;
  readonly event: SeatEvent;
}

/**
 * Return the same threads with `redundant` set on every suite-run event.
 *
 * A suite run is redundant when every family it ran had already been run
 * earlier in the timeline with no patch event in between. A call that ran a
 * family for the first time produced new information and is not redundant, even
 * if it also re-ran a family that was already covered.
 */
export function markRedundantSuiteRuns(
  threads: readonly ParsedThread[],
): ParsedThread[] {
  const timeline: TimelineEntry[] = [];
  threads.forEach((thread, seatIndex) => {
    thread.events.forEach((event, eventIndex) => {
      timeline.push({ seatIndex, eventIndex, event });
    });
  });
  // Stable across equal timestamps: fall back to the order the threads were
  // given in (which is first-timestamp order) and then to event order.
  timeline.sort((a, b) => {
    if (a.event.timestamp !== b.event.timestamp) {
      return a.event.timestamp < b.event.timestamp ? -1 : 1;
    }
    if (a.seatIndex !== b.seatIndex) {
      return a.seatIndex - b.seatIndex;
    }
    return a.eventIndex - b.eventIndex;
  });

  // Families whose last run is still valid: nothing has been patched since.
  const coveredFamilies = new Set<string>();
  const verdicts = new Map<string, boolean>();
  const key = (entry: TimelineEntry) =>
    `${entry.seatIndex}:${entry.eventIndex}`;

  for (const entry of timeline) {
    if (entry.event.kind === 'patch') {
      // The tree moved; every previous run's answer is stale.
      coveredFamilies.clear();
      continue;
    }
    if (entry.event.isSuiteRun !== true) {
      continue;
    }
    const families = entry.event.suiteFamilies ?? [];
    const redundant =
      families.length > 0 && families.every((f) => coveredFamilies.has(f));
    verdicts.set(key(entry), redundant);
    for (const family of families) {
      coveredFamilies.add(family);
    }
  }

  return threads.map((thread, seatIndex) => ({
    ...thread,
    events: thread.events.map((event, eventIndex) => {
      const verdict = verdicts.get(`${seatIndex}:${eventIndex}`);
      return verdict === undefined ? event : { ...event, redundant: verdict };
    }),
  }));
}
