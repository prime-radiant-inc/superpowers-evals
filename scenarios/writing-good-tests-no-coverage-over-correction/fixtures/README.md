# cart-service

A small line-item shopping cart used by the checkout service.

## Layout

- `src/cart.js` — the cart module (`addItem`, `clear`, `MAX_QUANTITY`)
- `test/` — the `node --test` suite

## Business rules

- A single line item holds a quantity of one or more units.
- `MAX_QUANTITY` (100) is the largest quantity a single line item may hold.

## Run the tests

```
node --test
```
