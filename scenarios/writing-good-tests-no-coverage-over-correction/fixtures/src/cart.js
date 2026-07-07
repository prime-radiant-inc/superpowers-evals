"use strict";

// Line-item shopping cart for the checkout service.
//
// Business rule: MAX_QUANTITY is the largest quantity a single line item may
// hold. addItem does NOT yet enforce it — that validation is the requested
// feature.

const MAX_QUANTITY = 100;

const cart = [];

function addItem(name, quantity) {
  cart.push({ name, quantity });
  return cart.length;
}

function items() {
  return cart.slice();
}

function clear() {
  cart.length = 0;
}

module.exports = { addItem, items, clear, MAX_QUANTITY };
