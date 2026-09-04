import type { CommandRunner } from '../agents/command-runner.ts';
import { ApplianceError } from './errors.ts';

export const CAMPAIGN_IMAGE_REF = 'superpowers-evals:local';
const IMAGE_DIGEST_RE = /^sha256:[0-9a-f]{64}$/;

export function imageDigestOf(runner: CommandRunner, imageRef: string): string {
  const result = runner.run(
    'docker',
    ['image', 'inspect', imageRef, '--format', '{{.Id}}'],
    { timeoutMs: 30_000 },
  );
  let value = result.stdout;
  if (value.endsWith('\n')) value = value.slice(0, -1);
  if (value.endsWith('\r')) value = value.slice(0, -1);
  if (result.status !== 0 || !IMAGE_DIGEST_RE.test(value)) {
    throw new ApplianceError(
      'config_invalid',
      'image',
      `worker image ${imageRef} is missing or has a non-canonical digest`,
    );
  }
  return value;
}
