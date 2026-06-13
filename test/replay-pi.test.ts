import { normalizePiLogs } from '../src/normalizers/pi.ts';
import { runReplayCases } from './replay-cases.ts';

runReplayCases('pi', normalizePiLogs);
