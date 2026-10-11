---
folder: deals
extends: goal
label: deal
codex_label: contract
template: _hippo/templates/deal.md
statuses:
  lead: active
  negotiating: active
  won: done
  lost: failed
  paused: dormant
fields:
  amount:
    kind: number
    description: What it's worth, in `currency`.
  currency:
    kind: enum
    values: [EUR, USD, GBP, TRY, BRL, JPY]
---
A piece of work being sold or done for a client: from lead to won or lost. The client is its `counterparty`; `due` is the next date that matters (a proposal to send, a delivery).

## Is
- Website for the Lisbon shop, 2,400 EUR, negotiating
- Monthly translation retainer with the language center

## Is not
- The bill for it (that's an `invoice`)
- The client itself (that's a `client`)
