---
folder: bills
extends: goal
label: bill
codex_label: tithe
template: _hippo/templates/bill.md
statuses:
  unpaid: active
  overdue: blocked
  paid: done
  cancelled: failed
fields:
  amount:
    kind: number
    description: How much, usually.
  currency:
    kind: text
---
Something the household pays, usually on repeat: rent, electricity, internet. Give it `repeat: { every: 1m }` and `due` on the next payment date; once paid, it comes back with the next one. Who it's paid to is the `counterparty`.

## Is
- Rent for the Alfama flat, 1,200 EUR on the 1st of every month
- The internet bill, every month

## Is not
- A one-time purchase (that's a `purchase` memory)
- An invoice the human sends (with the business preset, that's an `invoice`)
