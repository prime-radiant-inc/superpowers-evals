import { normalizeGeminiLogs } from '../src/normalizers/gemini.ts';
import { runReplayCases } from './replay-cases.ts';

runReplayCases('gemini', normalizeGeminiLogs);
