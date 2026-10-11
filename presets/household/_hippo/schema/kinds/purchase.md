---
behaviour: fact
data:
  item:
    kind: ref
    description: The asset bought, if it's one worth tracking.
  amount:
    kind: number
    description: What it cost.
  store:
    kind: text
    description: Where it was bought.
---
Something bought for the home: what, where, for how much, and the warranty if it has one.

## Is
- Bought a washing machine at the Lisbon appliance store for 420 EUR, 2-year warranty

## Is not
- A bill that comes back every month (that's a `bill`)
