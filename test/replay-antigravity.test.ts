import { normalizeAntigravityLogs } from '../src/normalizers/antigravity.ts';
import { runReplayCases } from './replay-cases.ts';

runReplayCases('antigravity', normalizeAntigravityLogs);
