---
merge: true
fields:
  email:
    identity_key: true
    description: An email address; identifies the person, so two notes with it are one person.
  phone:
    identity_key: true
    description: A phone number, international format.
  handle:
    identity_key: true
    description: A chat or social handle, with its network (`signal:@player`).
  birthday:
    kind: date
    recurs: yearly
    description: Birthday (YYYY-MM-DD; any year when it isn't known). Shows up in briefings as it comes around.
  employer:
    kind: text
    succession: true
    description: Where they work now; a newer report closes the old one into its history.
  title:
    kind: text
    succession: true
    description: Their job title now.
  city:
    kind: text
    succession: true
    description: The city they live in now.
  sensitivities:
    kind: text
    many: true
    human_only: true
    description: Topics to be careful with. Agents may only suggest them (as proposals).
---
With the people preset, a person's note is their rapport: `extends:` the archetype they are (stranger until sorted), guidelines scoped by language or channel (`lang:pt`), contact stats, open threads as goals with them as `counterparty`, and up to three short example messages under a human-written `## Example messages` heading.
