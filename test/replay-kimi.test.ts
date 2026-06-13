import { normalizeKimiLogs } from '../src/normalizers/kimi.ts';
import { runReplayCases } from './replay-cases.ts';

runReplayCases('kimi', normalizeKimiLogs);
