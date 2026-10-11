---
folder: invoices
extends: goal
label: invoice
codex_label: bill of sale
template: _hippo/templates/invoice.md
statuses:
  draft: dormant
  sent: active
  overdue: blocked
  paid: done
  void: failed
fields:
  number:
    identity_key: true
    description: The invoice number; identifies it.
  amount:
    kind: number
  currency:
    kind: enum
    values: [EUR, USD, GBP, TRY, BRL, JPY]
---
A bill sent to a client, tracked until it's paid. The client is its `counterparty` and `due` is when payment is due.

## Is
- Invoice 2026-014 to the language center, 600 EUR, due 2026-11-01

## Is not
- The work it bills for (that's a `deal`)
- A bill the human has to pay (with the household preset, that's a `bill`)
