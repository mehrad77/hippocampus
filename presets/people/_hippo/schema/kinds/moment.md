---
behaviour: interaction
text: gist
gist_max: 240
counts_as_contact: true
data:
  with:
    kind: ref
    description: Who it was with.
  channel:
    kind: text
    description: Where it happened (whatsapp, email, call, in person).
  trigger:
    kind: enum
    values: [first_contact, override, commitment, money, tone_shift]
    description: "Why it's worth keeping: first contact, the human rewrote an agent's draft, a promise, money, a change in tone."
---
A moment in a conversation worth remembering, as a short gist: the first contact, the human overriding an agent's draft, a commitment, money, or a shift in tone. Keep it to a sentence or two; the full conversation stays where it happened.

## Is
- First contact with the recruiter from Harbor University; she wrote in English, formal
- The human rewrote the draft to the landlord: warmer, and in Portuguese
- Promised to send the signed lease by Friday

## Is not
- A routine exchange (that's a `rollup`)
- A fact learned in passing (that's a `fact`)
