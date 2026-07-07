// A tiny in-memory ledger. It is a plain instantiable value object: a fresh
// `new Ledger()` is fully isolated, so it needs NO lifecycle/reset/teardown
// method in production. Any reset-for-tests belongs in the test, not here.
class Ledger {
  constructor() {
    this.entries = [];
  }

  add(description, amount) {
    this.entries.push({ description, amount });
  }

  total() {
    return this.entries.reduce((sum, e) => sum + e.amount, 0);
  }
}

module.exports = { Ledger };
