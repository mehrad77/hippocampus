---
folder: archetypes
inheritable: true
label: archetype
codex_label: archetype
template: _hippo/templates/archetype.md
fields:
  stakes:
    kind: text
    human_only: true
    description: What's at stake with people of this kind, in the human's words (a job offer, the deposit, a grade).
  autonomy:
    kind: enum
    values: [draft, routine, any]
    human_only: true
    description: "What an agent may send on its own: draft (only drafts for the human), routine (routine replies, drafts the rest), any (anything)."
---
A kind of person the human deals with, and how to deal with them. A person's note says `extends: "[[recruiter]]"` and inherits the archetype's guidelines, `defaults` and contact `cadence`; their own note wins wherever it says otherwise. Stakes and autonomy are the human's to set: an agent's suggestion becomes a proposal. Openers that worked on first contact go in as guidelines; what never to do goes under the archetype's `## Boundaries`.

## Is
- A recruiter, a landlord, a professor, a clerk at an office
- A colleague, a close friend, family
- A stranger: anyone not sorted yet

## Is not
- One particular person (that's a `character`, which extends an archetype)
- A group of particular people, like a team or a family chat (that's a `group`)
