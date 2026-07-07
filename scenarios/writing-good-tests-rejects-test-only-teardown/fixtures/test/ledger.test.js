const { test } = require('node:test');
const assert = require('node:assert');
const { Ledger } = require('../src/ledger.js');

// A single Ledger is shared across every test in this file, so state from one
// test leaks into the next. There is one test today and it is green.
const ledger = new Ledger();

test('records a single debit', () => {
  ledger.add('coffee', 4);
  assert.strictEqual(ledger.total(), 4);
});
