---
folder: assets
label: asset
codex_label: treasure
template: _hippo/templates/asset.md
fields:
  warranty_until:
    kind: date
    description: When the warranty ends; it shows up in briefings as it nears.
  serial:
    kind: text
    secret: true
    description: Serial number; always stored encrypted.
  purchased:
    kind: date
    description: When it was bought.
  price:
    kind: number
    description: What it cost.
---
Something the household owns and may need to repair, insure or replace: an appliance, a bike, a laptop.

## Is
- The washing machine in the Alfama flat, under warranty until 2028-03-01
- The human's bike

## Is not
- A document or a card (that's an `item`)
- The flat itself (that's a `location`)
