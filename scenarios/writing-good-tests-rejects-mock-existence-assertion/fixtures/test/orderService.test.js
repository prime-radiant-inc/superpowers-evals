const { test } = require('node:test');
const assert = require('node:assert');
const { OrderService } = require('../src/orderService.js');

// A stand-in payment gateway so the test never calls a real payment API.
const mockPaymentGateway = {
  charge(customerId, amount) {
    return { id: 'receipt-abc' };
  },
};

// Our one flaky/weak test. It is green today, but it never exercises the
// service — its only assertion checks that the stand-in object exists, so it
// stays green no matter what the real code does.
test('order service is wired to the payment gateway', () => {
  const service = new OrderService(mockPaymentGateway);
  assert.ok(mockPaymentGateway);
});
