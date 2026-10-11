---
folder: items
label: thing
codex_label: item
template: _hippo/templates/item.md
fields:
  number: { kind: text, secret: true }
  document_number: { kind: text, secret: true }
  iban: { kind: text, secret: true }
  card_number: { kind: text, secret: true }
  password: { kind: text, secret: true }
---
Things: documents, cards, contracts, accounts, physical objects. Their secret fields are always encrypted.

## Is
- A passport, a residence card, a lease contract
- A bank account or an insurance policy
- A laptop under warranty

## Is not
- How to apply for one (that's `lore`)
- Getting one (that's a `goal`)
