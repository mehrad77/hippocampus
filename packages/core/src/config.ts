import { isMap, isScalar, parse as parseYaml, type Document } from "yaml";
import { HippoConfig, type HumanDef } from "./schema.ts";

export const CONFIG_PATH = "_hippo/config.yaml";
/** The human's house rules for the curator, in plain words; appended to every curator prompt. */
export const CURATOR_RULES_PATH = "_hippo/curator.md";

/** The config of a vault without `_hippo/config.yaml`: the template's types, inline. */
export const DEFAULT_CONFIG: HippoConfig = HippoConfig.parse({
  version: 2,
  humans: [{ id: "human" }],
  types: {
    character: { folder: "characters", description: "People: the humans and everyone they deal with." },
    faction: { folder: "factions", description: "Organizations: institutions, companies, offices, groups." },
    location: { folder: "locations", description: "Places: cities, offices, apartments, campuses." },
    item: { folder: "items", description: "Things: documents, cards, contracts, accounts, physical objects." },
    lore: { folder: "lore", description: "Know-how: procedures, rules, and topic knowledge (how things work)." },
    goal: { folder: "goals", description: "Something to get done, with an owner, status, due date and progress.", capabilities: ["goal"] },
    arc: { folder: "arcs", description: "A long stretch of life that groups goals.", capabilities: ["arc"] },
    party: { folder: "party", description: "The AI agents: lane, authority domains, host.", capabilities: ["actor"] },
  },
  relations: ["member_of", "part_of", "located_in", "owns", "handles", "requires", "blocks", "involves", "works_at", "knows", "related_to"],
});

export function parseConfig(raw: string | undefined): HippoConfig {
  if (!raw) return DEFAULT_CONFIG;
  return HippoConfig.parse(parseYaml(raw) ?? {});
}

/**
 * A relation name as stored: a declared inverse (`used_by` of `depends_on: { inverse: used_by }`)
 * becomes its forward name with the direction flipped, so each edge is written once, one way.
 */
export function canonicalRelation(config: Pick<HippoConfig, "relations" | "relation_inverses">, rel: string): { rel: string; flip: boolean } {
  if (config.relations.includes(rel)) return { rel, flip: false };
  const forward = Object.entries(config.relation_inverses).find(([, inverse]) => inverse === rel)?.[0];
  return forward ? { rel: forward, flip: true } : { rel, flip: false };
}

/** `humans:` in place of a legacy `human:` key, keeping that key's comment and position. */
export function setHumans(doc: Document, humans: (Pick<HumanDef, "id" | "github"> & { domains?: string[] })[]): void {
  const compact = humans.map((h) => ({ id: h.id, ...(h.domains?.length ? { domains: h.domains } : {}), ...(h.github ? { github: h.github } : {}) }));
  const node = doc.createNode(compact);
  for (const item of node.items) if (isMap(item)) item.flow = true;
  const legacy = isMap(doc.contents) ? doc.contents.items.find((p) => isScalar(p.key) && p.key.value === "human") : undefined;
  if (legacy && isScalar(legacy.key) && !doc.has("humans")) {
    legacy.key.value = "humans";
    legacy.value = node;
  } else {
    doc.set("humans", node);
    doc.delete("human");
  }
}

/** No line folding, so the template's one-line flow maps and lists stay on one line. */
export const renderConfig = (doc: Document) => doc.toString({ lineWidth: 0, flowCollectionPadding: false });
