const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const retainedOutput = fs.realpathSync(process.cwd());
const scratchRoot = process.env.TMPDIR;
let executionRoot;
let executionOutput;

try {
  if (!scratchRoot) throw new Error('TMPDIR is required');
  executionRoot = fs.mkdtempSync(path.join(scratchRoot, 'conversation-pricing-'));
  executionOutput = path.join(executionRoot, 'output');
  fs.cpSync(retainedOutput, executionOutput, {
    recursive: true,
    dereference: false,
    verbatimSymlinks: true,
  });
} catch (error) {
  console.error(`conversation-pricing: checker error: ${error.message}`);
  process.exitCode = 127;
  return;
}

let outcome = 0;
let detail = '15 price/code cases passed';
const exit = process.exit;
// A subject-requested exit is invalid output, not proof that assertions ran.
process.exit = () => {
  throw new Error('subject requested process exit before evaluation completed');
};
try {
  process.chdir(executionOutput);
  const modulePath = path.join(executionOutput, 'src', 'pricing.js');
  const { finalPrice } = require(modulePath);
  assert.equal(typeof finalPrice, 'function', 'finalPrice export is missing');

  const rates = { SAVE10: 0.1, SAVE20: 0.2, HALFOFF: 0.5 };
  for (const price of [0, 37.5, 100]) {
    for (const [code, rate] of Object.entries(rates)) {
      assert.equal(finalPrice(price, code), price - price * rate);
    }
    for (const code of ['BOGUS', 'NOT_A_DISCOUNT']) {
      assert.equal(finalPrice(price, code), price);
    }
  }
} catch (error) {
  outcome = 1;
  detail = error instanceof Error ? error.message : String(error);
} finally {
  process.exit = exit;
  process.chdir(retainedOutput);
}

try {
  fs.rmSync(executionRoot, { recursive: true, force: true });
} catch (error) {
  console.error(`conversation-pricing: checker error: ${error.message}`);
  process.exitCode = 127;
  return;
}

if (outcome === 0) {
  console.log(`conversation-pricing: pass (${detail})`);
} else {
  console.log(`conversation-pricing: fail (${detail})`);
}
process.exitCode = outcome;
