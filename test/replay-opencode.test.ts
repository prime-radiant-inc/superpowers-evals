import { normalizeOpencodeLogs } from '../src/normalizers/opencode.ts';
import { runReplayCases } from './replay-cases.ts';

runReplayCases('opencode', normalizeOpencodeLogs);
