import { isMap, isScalar, parse as parseYaml, parseDocument, stringify as stringifyYaml, type Document } from "yaml";
import { VaultError } from "./errors.ts";
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
export function setHumans(doc: Document, humans: (Pick<HumanDef, "id" | "github" | "gitlab"> & { domains?: string[] })[]): void {
  const compact = humans.map((h) => ({ id: h.id, ...(h.domains?.length ? { domains: h.domains } : {}), ...(h.github ? { github: h.github } : {}), ...(h.gitlab ? { gitlab: h.gitlab } : {}) }));
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

/** A human's sign-in logins: a value sets it, `null` removes it, absent leaves it. */
export type HumanLogins = { [K in "github" | "gitlab"]?: string | null };

/**
 * The config (raw YAML) with one human's logins changed, as when a teammate joins or leaves a shared
 * vault. `create` adds the human when it isn't listed. A login moves: another human holding it gives it up.
 */
export function linkHuman(raw: string, id: string, logins: HumanLogins, create?: { domains?: string[] }): string {
  const humans: HumanDef[] = parseConfig(raw).humans.map((h) => ({ ...h }));
  let human = humans.find((h) => h.id === id);
  if (!human) {
    if (!create) throw new VaultError(`"${id}" is not one of this vault's humans (${humans.map((h) => h.id).join(", ")})`);
    human = { id, domains: create.domains ?? [] };
    humans.push(human);
  }
  for (const host of ["github", "gitlab"] as const) {
    const login = logins[host];
    if (login === undefined) continue;
    if (login === null) delete human[host];
    else {
      for (const other of humans) if (other !== human && other[host]?.toLowerCase() === login.toLowerCase()) delete other[host];
      human[host] = login;
    }
  }
  const doc = parseDocument(raw);
  // Only the `humans:` block is rewritten, in the file's own style; the human edits the rest of this file too.
  const pair = isMap(doc.contents) ? doc.contents.items.find((p) => isScalar(p.key) && (p.key.value === "humans" || p.key.value === "human")) : undefined;
  const start = (pair?.key as { range?: number[] } | undefined)?.range?.[0];
  const end = (pair?.value as { range?: number[] } | undefined)?.range?.[1];
  if (start === undefined || end === undefined) {
    setHumans(doc, humans);
    return renderConfig(doc);
  }
  const old = raw.slice(start, end);
  const pad = /\{ \S/.test(old) ? " " : "";
  const scalar = (v: string) => stringifyYaml(v).trimEnd();
  const lines = humans.map((h) => {
    const parts = [`id: ${scalar(h.id)}`, ...(h.domains.length ? [`domains: [${h.domains.map(scalar).join(", ")}]`] : []), ...(h.github ? [`github: ${scalar(h.github)}`] : []), ...(h.gitlab ? [`gitlab: ${scalar(h.gitlab)}`] : [])];
    return `  - {${pad}${parts.join(", ")}${pad}}`;
  });
  return `${raw.slice(0, start)}humans:\n${lines.join("\n")}${old.endsWith("\n") ? "\n" : ""}${raw.slice(end)}`;
}

/** No line folding, so the template's one-line flow maps and lists stay on one line. */
export const renderConfig = (doc: Document) => doc.toString({ lineWidth: 0, flowCollectionPadding: false });
