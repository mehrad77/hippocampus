---
folder: clients
inheritable: true
label: client
codex_label: patron
template: _hippo/templates/client.md
fields:
  website:
    identity_key: true
    description: The client's website; identifies them.
  payment_terms:
    kind: text
    description: How and when they pay (net 30, 50% upfront).
  currency:
    kind: enum
    values: [EUR, USD, GBP, TRY, BRL, JPY]
    description: The currency they're invoiced in.
---
Someone the human works for and bills: a company, an office, or a person paying for work. Its guidelines (how they like updates, who to copy) apply to every note that names the client in its tags. The people there are `character` notes that `works_at` the client.

## Is
- The language center that books translation work
- A small shop in Lisbon that ordered a website

## Is not
- One project or sale with them (that's a `deal`)
- A contact person at the client (that's a `character`)
