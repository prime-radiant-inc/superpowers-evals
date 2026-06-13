import { normalizeCopilotLogs } from '../src/normalizers/copilot.ts';
import { runReplayCases } from './replay-cases.ts';

runReplayCases('copilot', normalizeCopilotLogs);
