const { createHash } = require('node:crypto');
const { readFileSync } = require('node:fs');

// The review target from create_code_review_planted_bugs stays unchanged.
// This verifies source preservation, not the correctness of review findings.
const expected =
  '89d327d35e468272115f40b2f0b995a5b279ce61d5436701d7ca768913dcc6f0';

try {
  const actual = createHash('sha256')
    .update(readFileSync('src/db.js'))
    .digest('hex');
  if (actual !== expected) throw new Error('review target was changed');
  console.log('Review target preserved; findings require separate assessment.');
} catch (error) {
  console.error(`Review target preservation failed: ${error.message}`);
  process.exitCode = 1;
}
