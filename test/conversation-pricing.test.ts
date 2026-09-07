import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkScenario } from '../src/scaffold.ts';
import { runSetup } from '../src/setup-step.ts';

const SCENARIO = join(import.meta.dir, '../scenarios/conversation-pricing');
const ORACLE = join(SCENARIO, 'oracle.cjs');
function requireNode(): string {
  const node = Bun.which('node');
  if (node === null)
    throw new Error('node is required for pricing oracle tests');
  return node;
}
const NODE = requireNode();

function runOracle(
  source?: string,
  supplyScratch = true,
): {
  status: number | null;
  stdout: string;
  stderr: string;
  output: string;
} {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'pricing-oracle-')));
  const output = join(root, 'output');
  const scratch = join(root, 'scratch');
  mkdirSync(join(output, 'src'), { recursive: true });
  mkdirSync(scratch);
  if (source !== undefined)
    writeFileSync(join(output, 'src/pricing.js'), source);
  const proc = spawnSync(NODE, [ORACLE], {
    cwd: output,
    env: supplyScratch ? { TMPDIR: scratch } : {},
    encoding: 'utf8',
  });
  const result = {
    status: proc.status,
    stdout: proc.stdout,
    stderr: proc.stderr,
    output,
  };
  return result;
}

const HEADER = `
const RATES = { SAVE10: 0.1, SAVE20: 0.2, HALFOFF: 0.5 };
function getDiscountRate(code) {
`;
const FOOTER = `
}
function finalPrice(price, code) {
  const rate = getDiscountRate(code);
  return price - price * rate;
}
module.exports = { getDiscountRate, finalPrice };
`;

test('conversation pricing scenario validates and setup seeds only the pricing fixture', () => {
  expect(checkScenario(SCENARIO)).toEqual([]);
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'pricing-setup-')));
  runSetup(SCENARIO, root);
  expect(readFileSync(join(root, 'src/pricing.js'), 'utf8')).toBe(
    readFileSync(join(SCENARIO, 'fixtures/src/pricing.js'), 'utf8'),
  );
  expect(
    spawnSync('git', ['status', '--short'], { cwd: root, encoding: 'utf8' })
      .stdout,
  ).toBe('');
  rmSync(root, { recursive: true, force: true });
});

test('trusted oracle rejects unchanged, hardcoded, and known-discount regressions', () => {
  const unchanged = runOracle(`${HEADER}  return RATES[code];${FOOTER}`);
  expect(unchanged.status).toBe(1);
  expect(unchanged.stdout).toContain('conversation-pricing: fail');

  const hardcoded = runOracle(
    'function finalPrice() { return 90; }\nmodule.exports = { finalPrice };\n',
  );
  expect(hardcoded.status).toBe(1);

  const brokenKnown = runOracle(
    'function finalPrice(price) { return price; }\nmodule.exports = { finalPrice };\n',
  );
  expect(brokenKnown.status).toBe(1);
});

test('trusted oracle treats missing, invalid, and throwing subject modules as failures', () => {
  expect(runOracle().status).toBe(1);
  expect(runOracle('module.exports = {};\n').status).toBe(1);
  expect(runOracle('this is invalid javascript !!!\n').status).toBe(1);
  expect(runOracle('throw new Error("boom");\n').status).toBe(1);
});

test('trusted oracle requires its private scratch directory', () => {
  const valid = `${HEADER}  return RATES[code] ?? 0;${FOOTER}`;
  expect(runOracle(valid, false).status).toBe(127);
});

test('trusted oracle accepts fixes in either pricing function', () => {
  const producerFix = runOracle(`${HEADER}  return RATES[code] ?? 0;${FOOTER}`);
  expect(producerFix.status).toBe(0);
  expect(producerFix.stdout).toContain('conversation-pricing: pass');

  const consumerFix = runOracle(`
const RATES = { SAVE10: 0.1, SAVE20: 0.2, HALFOFF: 0.5 };
function getDiscountRate(code) { return RATES[code]; }
function finalPrice(price, code) {
  const rate = getDiscountRate(code) ?? 0;
  return price - price * rate;
}
module.exports = { getDiscountRate, finalPrice };
`);
  expect(consumerFix.status).toBe(0);
});

test('trusted oracle imports a scratch copy and leaves retained output untouched', () => {
  const source = `
const fs = require('node:fs');
fs.writeFileSync('import-side-effect.txt', 'scratch only');
const RATES = { SAVE10: 0.1, SAVE20: 0.2, HALFOFF: 0.5 };
function finalPrice(price, code) { return price - price * (RATES[code] ?? 0); }
module.exports = { finalPrice };
`;
  const result = runOracle(source);
  expect(result.status).toBe(0);
  expect(readdirSync(result.output)).toEqual(['src']);
  expect(readFileSync(join(result.output, 'src/pricing.js'), 'utf8')).toBe(
    source,
  );
});
