// A frozen v1 vault (fictional, from seeds/example-relocation) for the v1 → v2 migration tests.
// Never update it to the current format: it stands for vaults written by v1 Hippocampus.

export const V1_CONFIG = `# Hippocampus vault configuration.
version: 1

# Name of the campaign (shown in the Player's Handbook).
campaign: lisbon-arc

# IANA timezone for chronicle days/times.
timezone: Europe/Lisbon

# Party id of the human player. Their word outranks every agent; \`ruling:\` in disputes is theirs.
human: player

# Domains are the tags that define lanes.
domains: [residency, housing, university, story]

# Entity types and where their notes live. \`secret_fields\` are always encrypted.
types:
  character: { folder: characters, description: "People and NPCs, including the player character." }
  item:
    folder: items
    description: "Documents, cards, contracts, accounts, physical things."
    secret_fields: [number, iban]
  lore: { folder: lore, description: "How things work at Harbor University." }
  quest: { folder: quests, description: "Goals with objectives, owner lane, status, clocks, deadlines." }
  campaign: { folder: campaigns, description: "Long arcs that group quests." }
  party: { folder: party, description: "The agents themselves: lane, authority domains, host." }
  course: { folder: studies/courses, description: "Courses at Harbor University.", secret_fields: [portal_pin] }

# Relation vocabulary the curator may use between entities.
relations: [part_of, involves, located_in, requires]

curator:
  canon_threshold: 2      # distinct agents needed to promote a rumor to canon
  batch_size: 25          # max episodes per sleep

secrets:
  # age public key; set by \`hippo secrets keygen\`.
  recipient: null
`;

/** The v1 template's quest template and quest board, exactly as v1 shipped them. */
export const V1_QUEST_TEMPLATE = `---
type: quest
title: "{{title}}"
aliases: []
tags: []
status: active
owner: ""
deadline:
---

%% hippo:begin objectives %%
- [ ] First objective
%% hippo:end objectives %%

## Notes
`;

export const V1_CAMPAIGN_TEMPLATE = `---
type: campaign
title: "{{title}}"
aliases: []
tags: []
---

## Notes
`;

export const V1_QUEST_BOARD = `# 🗺 Quest board

> Requires the Dataview community plugin.

## Active quests

\`\`\`dataview
TABLE WITHOUT ID file.link AS Quest, status AS Status, owner AS Owner, deadline AS Due
FROM "quests"
WHERE status != "done" AND status != "failed"
SORT deadline ASC
\`\`\`

## Open objectives

\`\`\`dataview
TASK
FROM "quests"
WHERE !completed
GROUP BY file.link
\`\`\`

## Recently completed

\`\`\`dataview
TABLE WITHOUT ID file.link AS Quest, updated AS Updated
FROM "quests"
WHERE status = "done"
SORT updated DESC
LIMIT 10
\`\`\`
`;

export const V1_FILES: Record<string, string> = {
  "_hippo/config.yaml": V1_CONFIG,
  "_hippo/templates/quest.md": V1_QUEST_TEMPLATE,
  "_hippo/templates/campaign.md": V1_CAMPAIGN_TEMPLATE,
  "_hippo/templates/character.md": `---\ntype: character\ntitle: "{{title}}"\naliases: []\ntags: []\n---\n\n## Notes\n`,
  "_hippo/dashboards/quest-board.md": V1_QUEST_BOARD,
  "quests/.gitkeep": "",
  "campaigns/.gitkeep": "",
  "quests/residence-permit.md": `---
type: quest
title: Residence permit
aliases: []
tags: [residency]
status: active
owner: "[[residency-agent]]"
deadline: 2026-11-30
clocks:
  - { name: Paperwork, segments: 6, filled: 2 }
  - { name: Savings, segments: 4, filled: 1, deadline: 2026-10-31 }
relations: [{ rel: part_of, target: "[[lisbon-arc]]" }]
---

%% hippo:begin objectives %%
- [x] Address proof
- [ ] Agency appointment
%% hippo:end objectives %%

%% hippo:begin clocks %%
- Paperwork ◔ 2/6
- Savings ◔ 1/4
%% hippo:end clocks %%

## Notes
Bring two biometric photos to the [[migration-agency]].
`,
  "campaigns/lisbon-arc.md": `---
type: campaign
title: The Lisbon Arc
aliases: [Lisbon arc]
tags: [story]
relations: [{ rel: involves, target: "[[player]]" }]
---

## Notes
Moving to Lisbon to study at [[harbor-university]].
`,
  "party/residency-agent.md": `---\ntype: party\ntitle: Residency Agent\naliases: []\ntags: []\nlane: "Student residence permit end-to-end."\nauthority: [residency]\nhost: any MCP client\n---\n\n## Notes\nOwns [[residence-permit]].\n`,
  "party/game-master.md": `---\ntype: party\ntitle: Game Master\naliases: []\ntags: []\nlane: "Story framing."\nauthority: [story]\nhost: any MCP client\n---\n\n## Notes\nSubmits \`kind: beat\` episodes.\n`,
  "characters/player.md": `---\ntype: character\ntitle: Player\naliases: []\ntags: [pc]\nfacts:\n  student_number: HU-2026-0042\n---\n\n## Notes\nA student relocating to Lisbon.\n`,
  "studies/courses/portuguese-a2.md": `---\ntype: course\ntitle: Portuguese A2\naliases: []\ntags: [university]\n---\n\n## Notes\nAt the [[language-center]].\n`,
  "inbox/game-master/2026-09-27T100000-arrival.md": `---\nagent: game-master\nkind: beat\nat: 2026-09-27T10:00:00+01:00\nabout: ["[[lisbon-arc]]"]\n---\nThe player lands in Lisbon; the arc begins.\n`,
  "disputes/dispute-residence-permit-office.md": `---\ntype: dispute\nentity: "[[residence-permit]]"\nfield: office\nstatus: open\nclaims:\n  - value: Alfama\n    by: residency-agent\n  - value: Baixa\n    by: campus-agent\n---\n`,
};

/** A v2 template, as small as the migration needs: type, kind and scaffold notes. */
export const V2_TEMPLATE: Record<string, string> = {
  "_hippo/schema/types/character.md": `---\nfolder: characters\ntemplate: _hippo/templates/character.md\n---\nPeople: the humans and everyone they deal with.\n\n## Is\n- A landlord\n\n## Is not\n- An organization\n`,
  "_hippo/schema/types/item.md": `---\nfolder: items\nfields:\n  number: { kind: text, secret: true }\n---\nDocuments, cards, contracts, accounts, things.\n`,
  "_hippo/schema/types/lore.md": `---\nfolder: lore\n---\nHow things work: procedures, rules, topic knowledge.\n`,
  "_hippo/schema/types/goal.md": `---\nfolder: goals\ncapabilities: [goal]\ntemplate: _hippo/templates/goal.md\ncodex_label: quest\n---\nSomething to get done, with an owner and a status.\n`,
  "_hippo/schema/types/arc.md": `---\nfolder: arcs\ncapabilities: [arc]\ntemplate: _hippo/templates/arc.md\ncodex_label: campaign\n---\nA long stretch of life that groups goals.\n`,
  "_hippo/schema/types/party.md": `---\nfolder: party\ncapabilities: [actor]\nlabel: agent\n---\nThe agents themselves.\n`,
  "_hippo/schema/kinds/observation.md": `---\nbehaviour: observation\n---\nSomething noticed or learned.\n`,
  "_hippo/schema/kinds/beat.md": `---\nalias_of: observation\n---\nA story beat.\n`,
  "_hippo/templates/goal.md": `---\ntype: goal\ntitle: "{{title}}"\naliases: []\ntags: []\nstatus: active\nowner: ""\ndue:\n---\n\n%% hippo:begin objectives %%\n- [ ] First objective\n%% hippo:end objectives %%\n\n## Notes\n`,
  "_hippo/templates/arc.md": `---\ntype: arc\ntitle: "{{title}}"\naliases: []\ntags: []\n---\n\n## Notes\n`,
  "_hippo/dashboards/goal-board.md": `# 🎯 Goals\n\n\`\`\`dataview\nTABLE WITHOUT ID file.link AS Goal, status AS Status, owner AS Owner, due AS Due\nFROM "goals"\nWHERE status != "done" AND status != "failed"\nSORT due ASC\n\`\`\`\n`,
};
