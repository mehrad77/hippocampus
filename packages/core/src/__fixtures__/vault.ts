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

/**
 * The fixture vault's config as a v2 vault would have it: types with capabilities, and the goal type
 * from a schema note (`GOAL_TYPE_NOTE`, folder `goals/`) instead of the inline v1 `quest`.
 */
export const V2_CONFIG = `version: 2
name: lisbon-arc
humans: [{ id: player }]
domains: [residency, housing, university, career]
types:
  character: { folder: characters, description: People }
  faction: { folder: factions, description: Organizations }
  location: { folder: locations, description: Places }
  item: { folder: items, description: Documents, secret_fields: [number] }
  lore: { folder: lore, description: Procedures }
  arc: { folder: arcs, description: Arcs, capabilities: [arc] }
  party: { folder: party, description: Agents, capabilities: [actor] }
relations: [handles, located_in, requires, part_of, involves, owns]
`;

export const GOAL_TYPE_NOTE = "---\nfolder: goals\ncapabilities: [goal]\n---\nThings to get done.\n";

/** The fixture's residence-permit quest as the v1→v2 migration writes it, under `goals/`. */
export const MIGRATED_QUEST = `---\ntype: goal\ntitle: Residence permit 2026\ntags: [residency]\nstatus: active\nowner: "[[residency-agent]]"\ndue: 2026-11-30\n---\n%% hippo:begin objectives %%\n- [ ] Get health insurance\n- [ ] Book agency appointment\n%% hippo:end objectives %%\n\n%% hippo:begin progress %%\ndue 2026-11-30\n%% hippo:end progress %%\n`;
