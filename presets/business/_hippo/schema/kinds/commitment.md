---
behaviour: task
text: optional
goal_type: deal
data:
  title:
    kind: text
    required: true
    description: What was promised, short and imperative.
  counterparty:
    kind: ref
    description: Who it was promised to.
  due:
    kind: date
    description: By when.
  owner:
    kind: ref
    description: Who has to deliver it.
---
A promise made to or by a client: it becomes a deal with that client as counterparty and its due date, or updates the open deal with the same title.

## Is
- Promised the Lisbon shop a quote by 2026-10-20
- The language center will send the glossary by Friday

## Is not
- A general to-do with no one on the other side (that's a `task`)
