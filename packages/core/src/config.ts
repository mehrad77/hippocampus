import { parse as parseYaml } from "yaml";
import { HippoConfig } from "./schema.ts";

export const CONFIG_PATH = "_hippo/config.yaml";
/** The human's house rules for the curator, in plain words; appended to every curator prompt. */
export const CURATOR_RULES_PATH = "_hippo/curator.md";

export const DEFAULT_CONFIG: HippoConfig = HippoConfig.parse({
  campaign: "campaign",
  human: "human",
  types: {
    character: { folder: "characters", description: "People and NPCs, including the player character." },
    faction: { folder: "factions", description: "Organizations, institutions, companies, groups." },
    location: { folder: "locations", description: "Places: cities, offices, apartments, campuses." },
    item: { folder: "items", description: "Documents, cards, contracts, accounts, physical things." },
    lore: { folder: "lore", description: "Procedures, rules, and topic knowledge (how things work)." },
    quest: { folder: "quests", description: "Goals with objectives, owner lane, status, clocks, deadlines." },
    campaign: { folder: "campaigns", description: "Long arcs that group quests." },
    party: { folder: "party", description: "The agents themselves: lane, authority domains, host." },
  },
  relations: ["member_of", "part_of", "located_in", "owns", "handles", "requires", "blocks", "involves", "works_at", "knows", "related_to"],
});

export function parseConfig(raw: string | undefined): HippoConfig {
  if (!raw) return DEFAULT_CONFIG;
  return HippoConfig.parse(parseYaml(raw) ?? {});
}
