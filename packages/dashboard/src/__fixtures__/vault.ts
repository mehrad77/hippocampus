import type { MemoryStore } from "@hippocampus/core";
import { fixtureStore } from "../../../core/src/__fixtures__/vault.ts";

// A small fictional vault (seeds/example-relocation names) with everything the dashboard shows:
// a dispute, rumors, stale canon, a sealed secret, a secret inbox episode, the chronicle and a last sleep.
// Vault files exist only as strings here, never as files in the repo.

export const NOW = new Date("2026-09-27T12:00:00.000Z");
export const now = () => NOW;

/** The plaintext of the secret inbox episode: no dashboard response may ever contain it. */
export const SECRET_PLAINTEXT = "U12345678";

const CHRONICLE = `---
type: chronicle
date: 2026-09-25
---
# 2026-09-25

> [!episode] 09:15 · [[residency-agent]] · fact
> The agency moved the appointment to 2026-10-14.
>
> ↳ [[migration-agency]] · [[residence-permit]]

^ep-01AAA

> [!episode] 18:40 · [[job-scout]] · observation
> Saw a listing near Alfama.

^ep-01BBB
`;

export function richStore(): MemoryStore {
  return fixtureStore({
    "factions/migration-agency.md": `---
type: faction
title: Agência de Migração
aliases: [Lisbon Migration, LMA]
tags: [residency]
relations: [{ rel: handles, target: "[[residence-permit]]" }]
facts:
  office_address: { value: Alfama, status: disputed, by: campus-agent, at: "2026-09-10T00:00:00Z", src: [ep-a] }
  phone: { value: "+351 000", status: canon, by: residency-agent, at: "2026-05-01T00:00:00Z", src: [ep-old] }
  hours: { value: "9-16", status: rumor, by: home-finder, at: "2026-09-20T00:00:00Z", src: [ep-h], seen_by: [home-finder] }
---

## Notes
Human prose that must survive.
`,
    "quests/residence-permit.md": `---
type: quest
title: Residence permit 2026
tags: [residency]
status: active
owner: "[[residency-agent]]"
deadline: 2026-11-30
clocks: [{ name: Paperwork, segments: 6, filled: 2 }]
---
%% hippo:begin objectives %%
- [x] Get health insurance
- [ ] Book agency appointment
%% hippo:end objectives %%
`,
    "items/passport.md": `---
type: item
title: Passport
tags: [residency]
facts:
  number: { value: "secret://passport/number", status: canon, by: residency-agent, at: "2026-09-10T00:00:00Z", src: [ep-s] }
---
`,
    "locations/harbor-cafe.md": `---\ntype: location\ntitle: Harbor Cafe\n---\n`,
    "disputes/dispute-migration-agency-office-address.md": `---
type: dispute
entity: "[[migration-agency]]"
field: office_address
status: open
claims:
  - { value: Alfama, by: campus-agent, at: "2026-09-10T00:00:00Z", src: [ep-a] }
  - { value: Belém, by: home-finder, at: "2026-09-11T00:00:00Z", src: [ep-b] }
opened: "2026-09-11T00:00:00Z"
---
`,
    "chronicle/2026/09/2026-09-25.md": CHRONICLE,
    "inbox/residency-agent/2026-09-26T100000-aaaaaa.md": `---\nid: ep-in1\nagent: residency-agent\nkind: fact\nat: "2026-09-26T10:00:00Z"\nabout: ["[[migration-agency]]"]\n---\nAgency opens at 9.\n`,
    "inbox/residency-agent/2026-09-26T110000-bbbbbb.md": `---\nid: ep-in2\nagent: residency-agent\nkind: fact\nat: "2026-09-20T11:00:00Z"\nabout: ["[[passport]]"]\nsecret: true\n---\nPassport number is ${SECRET_PLAINTEXT}.\n`,
    "inbox/job-scout/2026-09-26T120000-cccccc.md": `---\nid: ep-in3\nagent: job-scout\nkind: observation\nat: "2026-09-26T12:00:00Z"\n---\nA cafe is hiring.\n`,
    "_hippo/review.md": `---\ntype: review\ngenerated: "2026-09-25T03:30:00.000Z"\n---\n# Morning review\n`,
  });
}
