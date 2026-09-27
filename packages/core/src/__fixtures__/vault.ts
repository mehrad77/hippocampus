import { MemoryStore } from "../store.ts";

export const CONFIG = `version: 1
campaign: lisbon-arc
human: player
domains: [residency, housing, university, career]
types:
  character: { folder: characters, description: People }
  faction: { folder: factions, description: Organizations }
  location: { folder: locations, description: Places }
  item: { folder: items, description: Documents, secret_fields: [number] }
  lore: { folder: lore, description: Procedures }
  quest: { folder: quests, description: Goals }
  campaign: { folder: campaigns, description: Arcs }
  party: { folder: party, description: Agents }
relations: [handles, located_in, requires, part_of, involves, owns]
`;

export function fixtureStore(extra: Record<string, string> = {}): MemoryStore {
  return new MemoryStore({
    "_hippo/config.yaml": CONFIG,
    "party/residency-agent.md": `---\ntype: party\ntitle: Residency Agent\nlane: student residence permit end-to-end\nauthority: [residency]\n---\n`,
    "party/campus-agent.md": `---\ntype: party\ntitle: Campus Agent\naliases: [Campus]\nlane: University admin\nauthority: [university]\n---\n`,
    "party/home-finder.md": `---\ntype: party\ntitle: Home Finder\nlane: housing\nauthority: [housing]\n---\n`,
    "factions/migration-agency.md": `---\ntype: faction\ntitle: Agência de Migração\naliases: [Lisbon Migration, LMA]\ntags: [residency]\n---\n\n## Notes\nHuman prose that must survive.\n`,
    "quests/residence-permit.md": `---\ntype: quest\ntitle: Residence permit 2026\ntags: [residency]\nstatus: active\nowner: "[[residency-agent]]"\ndeadline: 2026-11-30\n---\n%% hippo:begin objectives %%\n- [ ] Get health insurance\n- [ ] Book agency appointment\n%% hippo:end objectives %%\n`,
    ...extra,
  });
}
