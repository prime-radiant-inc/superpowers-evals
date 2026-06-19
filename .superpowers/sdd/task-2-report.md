# Task 2 Report

## Status

DONE

## Files Changed

- `src/appliance/locks.ts`
- `src/appliance/jobs.ts`
- `test/appliance-locks.test.ts`
- `test/appliance-jobs.test.ts`
- `.superpowers/sdd/task-2-report.md`

## RED Evidence

- Wrote `test/appliance-locks.test.ts` and `test/appliance-jobs.test.ts` first.
- Ran `bun test ./test/appliance-locks.test.ts ./test/appliance-jobs.test.ts`.
- Confirmed the expected RED failure:
  - `Cannot find module '../src/appliance/locks.ts'`
  - `Cannot find module '../src/appliance/jobs.ts'`
  - `0 pass, 2 fail, 2 errors`

## GREEN Evidence

- Implemented directory locks in `src/appliance/locks.ts`:
  - exclusive `mkdir` lock acquisition under `<loaded.paths.locks>/<name>`;
  - `lock.json` writes through `atomicWriteJson`;
  - `lock_busy` errors with holder job IDs when readable;
  - reverse-order release through `withMutationLocks`;
  - owner-checked release and stale PID inspection.
- Implemented file-backed jobs in `src/appliance/jobs.ts`:
  - private `<jobs>/<job-id>/` directories;
  - `job.json` writes through `atomicWriteJson`;
  - sibling `stdout.log` and `stderr.log`;
  - provenance paths under `loaded.paths.provenance`;
  - schema-validated create/read/update flows;
  - immutable `job_id` enforcement.
- Re-ran `bun test ./test/appliance-locks.test.ts ./test/appliance-jobs.test.ts` and got `7 pass, 0 fail`.

## Verification

- `bun test ./test/appliance-locks.test.ts ./test/appliance-jobs.test.ts`
  - Result: `7 pass, 0 fail, 24 expect() calls`
- `bun run typecheck`
  - Result: `tsc --noEmit` exited 0
- `bun x biome check src/appliance/locks.ts src/appliance/jobs.ts test/appliance-locks.test.ts test/appliance-jobs.test.ts`
  - Result: `Checked 4 files. No fixes applied.`

## Commit

- Commit hash: finalized after this report is committed; see the final Task 2 handoff for the immutable hash.
- Commit message: `appliance: add locks and job records`

## Concerns / Residuals

- Artifact-ID lookup is implemented for straightforward `run_id` and `batch_id` matches by scanning job records.
- `LockRecord.pgid` currently records `process.pid`, matching the host-helper process available at this layer; live process-group ownership belongs to later worker/cancellation tasks.
