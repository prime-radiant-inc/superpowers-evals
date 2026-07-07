// Places an order through an injected payment gateway. The gateway is a
// constructor collaborator so a test can substitute a stand-in for the real
// payment API. checkout totals the line items, charges the gateway, and
// returns the total plus the receipt id.
class OrderService {
  constructor(paymentGateway) {
    this.paymentGateway = paymentGateway;
  }

  checkout(order) {
    if (!order.items || order.items.length === 0) {
      throw new Error('cannot checkout an empty order');
    }
    const total = order.items.reduce(
      (sum, item) => sum + item.price * item.qty,
      0,
    );
    const receipt = this.paymentGateway.charge(order.customerId, total);
    return { total, receiptId: receipt.id };
  }
}

module.exports = { OrderService };
