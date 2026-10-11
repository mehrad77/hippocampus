import {
  GoalState,
  displayName,
  formatValue,
  getSummary,
  isHiddenFact,
  truncate,
  type Entity,
  type Episode,
  type EpisodeData,
  type ResolvedType,
  type SchemaRegistry,
  type Vault,
} from "@hippocampus/core";
import { z } from "zod";

// Every step is a small, strictly-typed call so that small local models cope.

const oneOf = (values: string[]) => z.enum((values.length ? values : ["none"]) as [string, ...string[]]);

/** Examples per side (`## Is`, `## Is not`) a type shows the curator, and their length. */
const EXAMPLES = 2;
const EXAMPLE_MAX = 120;

/** Types a mention may have: agents aren't the subject of memories, so actor types are left out. */
export function mentionTypes(schema: SchemaRegistry): ResolvedType[] {
  return schema.types().filter((t) => !t.capabilities.includes("actor"));
}

export function mentionsSchema(schema: SchemaRegistry) {
  const types = mentionTypes(schema).map((t) => t.name);
  return z.object({
    entities: z.array(
      z.object({
        name: z.string().describe("Most specific proper name, in the original language/spelling"),
        type: oneOf(types),
        aliases: z.array(z.string()).describe("Other spellings, translations, abbreviations mentioned"),
        domains: z.array(z.string()).describe("Applicable domains from the provided list, plus at most one new lowercase-dashed area when none fits"),
      }),
    ),
  });
}
export type Mentions = z.infer<ReturnType<typeof mentionsSchema>>;

export const matchSchema = (slugs: string[]) =>
  z.object({ match: oneOf([...slugs, "new"]).describe('The slug of the existing entity, or "new"') });

/** What a claims step may refer to besides the episode's entities. */
export interface ClaimsContext {
  /** Open goals, by slug. */
  goals: string[];
  /** Ids of open questions on the episode's entities; without any, `answered` isn't asked. */
  questions?: string[];
}

/** Status words a goal update may use: "unchanged", the core states and every goal type's own vocabulary. */
export function goalStatuses(vault: Vault): string[] {
  const vocab = vault.schema.types().flatMap((t) => (t.capabilities.includes("goal") ? Object.keys(t.statuses ?? {}) : []));
  return ["unchanged", ...new Set([...GoalState.options, ...vocab])];
}

/** Who may own a commitment: the episode's entities, the agents and the humans. */
export function owners(vault: Vault, slugs: string[]): string[] {
  return [...new Set([...slugs, ...vault.withCapability("actor").map((a) => a.slug), ...vault.config.humans.map((h) => h.id)])];
}

/** Stored relay answers and older scripts say `quests` / `quest`; they parse as `goals` / `goal`. */
function legacyClaims(v: unknown): unknown {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return v;
  const { quests, ...rest } = v as Record<string, unknown>;
  if (rest.goals !== undefined || !Array.isArray(quests)) return quests === undefined ? v : rest;
  const goals = quests.map((q) => {
    if (typeof q !== "object" || q === null) return q;
    const { quest, ...g } = q as Record<string, unknown>;
    return g.goal === undefined ? { goal: quest, ...g } : g;
  });
  return { ...rest, goals };
}

const isoDate = (what: string) => z.string().describe(`${what} (YYYY-MM-DD), only if stated`);

export function claimsSchema(vault: Vault, slugs: string[], ctx: ClaimsContext) {
  const relations = [...vault.config.relations, ...Object.values(vault.config.relation_inverses)];
  const shape = {
    facts: z.array(
      z.object({
        entity: oneOf(slugs),
        field: z.string().describe("snake_case attribute name; reuse an existing field name when the meaning matches"),
        value: z.string().describe("Normalized value: ISO dates, amounts with currency, exact IDs"),
        secret: z.boolean().describe("true for ID/passport/permit/bank/card numbers, passwords, credentials"),
        confidential: z.boolean().optional().describe("true for private details to keep out of summaries and search (health, money, family matters)"),
        scope: z.string().optional().describe("Context the value holds in (lang:pt, at:work); omit when it always holds"),
        valid_from: isoDate("When the value started being true").optional(),
        valid_until: isoDate("When the value stopped being true").optional(),
      }),
    ),
    relations: z.array(
      z.object({
        from: oneOf(slugs),
        rel: oneOf(relations),
        to: oneOf(slugs),
        role: z.string().optional().describe("What `from` is in the relation (works_at → engineer), only if stated"),
        valid_from: isoDate("Since when").optional(),
        valid_until: isoDate("Until when").optional(),
      }),
    ),
    goals: z
      .array(
        z.object({
          goal: oneOf(ctx.goals),
          status: oneOf(goalStatuses(vault)),
          completed: z.array(z.string()).describe("Objectives the episode says are now done"),
          added: z.array(z.string()).describe("New objectives/next steps the episode introduces"),
          progress: z
            .object({ done: z.number().int().nonnegative(), total: z.number().int().positive().optional() })
            .optional()
            .describe("Steps done out of total, only if the episode gives numbers"),
        }),
      )
      .default([]),
    commitments: z
      .array(
        z.object({
          title: z.string().describe("Short imperative title of what was promised or must be done"),
          owner: oneOf(owners(vault, slugs)).optional().describe("Who has to do it"),
          counterparty: oneOf(slugs).optional().describe("Who it is for or with"),
          due: isoDate("Due date").optional(),
          objectives: z.array(z.string()).optional().describe("Steps, if the episode lists them"),
        }),
      )
      .default([]),
    guidelines: z
      .array(
        z.object({
          entity: oneOf(slugs),
          rule: z.string().describe("How to treat this entity from now on, as an instruction"),
          scope: z.string().optional().describe("Context the rule holds in (lang:pt); omit when it always holds"),
        }),
      )
      .default([]),
  };
  const questions = ctx.questions ?? [];
  const object = questions.length
    ? z.object({ ...shape, answered: z.array(oneOf(questions)).default([]).describe("Ids of open questions this episode answers") })
    : z.object(shape);
  return z.preprocess(legacyClaims, object) as unknown as z.ZodType<Claims>;
}

export interface Claims {
  facts: { entity: string; field: string; value: string; secret: boolean; confidential?: boolean; scope?: string; valid_from?: string; valid_until?: string }[];
  relations: { from: string; rel: string; to: string; role?: string; valid_from?: string; valid_until?: string }[];
  goals: { goal: string; status: string; completed: string[]; added: string[]; progress?: { done: number; total?: number } }[];
  commitments: Commitment[];
  guidelines: { entity: string; rule: string; scope?: string }[];
  /** Asked only when the episode's entities have open questions. */
  answered?: string[];
}

export interface Commitment {
  title: string;
  owner?: string;
  counterparty?: string;
  due?: string;
  objectives?: string[];
}

export const summarySchema = z.object({
  summary: z.string().describe("2–4 sentences, present tense, with [[slug]] links to related entities"),
});

/** The human's house rules go last, so they read as the final word on judgment calls; the schema still binds. */
function withHouseRules(system: string, houseRules?: string): string {
  const rules = houseRules?.trim();
  if (!rules) return system;
  return `${system}

House rules from the vault's human (they override general guidance where they conflict, but never the JSON schema):
${rules}`;
}

const scalar = (v: unknown) => (typeof v === "string" && /[:#\n[\]{},]|^\s|\s$/.test(v) ? JSON.stringify(v) : String(v));

/** An episode's data as YAML lines (`  key: value`, lists in flow style). */
export function dataYaml(data: EpisodeData): string {
  return Object.entries(data)
    .map(([k, v]) => `  ${k}: ${Array.isArray(v) ? `[${v.map(scalar).join(", ")}]` : scalar(v)}`)
    .join("\n");
}

function episodeBlock(vault: Vault, ep: Episode): string {
  const kind = vault.schema.kind(ep.kind).def;
  const lines = [
    `Episode ${ep.id}`,
    `Reported by: ${ep.agent}`,
    `Kind: ${ep.kind}${kind.description ? ` (${kind.description})` : ""}`,
    `Reported at: ${ep.at}`,
    ...(ep.about.length ? [`About (hints): ${ep.about.join(", ")}`] : []),
    ...(ep.confidence !== undefined ? [`Confidence: ${ep.confidence}`] : []),
    ...(ep.scope ? [`Scope: ${ep.scope} (facts and guidelines hold in this context unless the episode says otherwise)`] : []),
    ...(ep.confidential ? ["Confidential: yes (use it to curate; it never appears in summaries, search or the chronicle)"] : []),
    ...(ep.data && Object.keys(ep.data).length ? [`Data:\n${dataYaml(ep.data)}`] : []),
  ];
  return `${lines.join("\n")}
---
${ep.text}
---`;
}

/** One type for the mentions step: its description, then up to two short examples of what it is and isn't. */
function typeLine(t: ResolvedType): string {
  const pick = (xs: string[]) => xs.slice(0, EXAMPLES).map((x) => truncate(x, EXAMPLE_MAX));
  const is = pick(t.examples.is);
  const isNot = pick(t.examples.isNot);
  return [
    `- ${t.name}: ${t.description}`,
    ...(is.length ? [`    is: ${is.join("; ")}`] : []),
    ...(isNot.length ? [`    is not: ${isNot.join("; ")}`] : []),
  ].join("\n");
}

const intro = (vault: Vault) =>
  `You are the curator of a shared memory vault ("${vault.config.name}") that several AI agents write to about one person's life and work.`;

export function mentionsPrompt(vault: Vault, ep: Episode, houseRules?: string) {
  const { config } = vault;
  const types = mentionTypes(vault.schema).map(typeLine).join("\n");
  const goals = vault
    .withCapability("goal")
    .map((q) => `- ${displayName(q)}`)
    .join("\n");
  return {
    system: withHouseRules(
      `${intro(vault)}
Your job in this step: list the entities an episode says something about.

Entity types:
${types}

Rules:
- Include people, organizations, places, documents/items, procedures, and goals that the episode states facts about.
- Do NOT include the reporting agent, dates, times, amounts, or generic nouns ("the office", "an email") as entities.
- IDs, numbers, codes, emails, and phone numbers are never entities or aliases. They are facts about an entity (a later step extracts them).
- If the episode is progress on an existing goal, include that goal by its name.
- name: the most specific proper name as written (keep the original-language spelling). Put translations/abbreviations in aliases.
- domains: choose from [${config.domains.join(", ")}]. Only when the entity clearly belongs to an area of the person's life that none of these covers, add one new area as a short lowercase word with dashes (like health or side-project): never a name, number or private detail. Empty if none apply.
- Return an empty list if there is nothing durable to remember.`,
      houseRules,
    ),
    prompt: `Existing goals:
${goals || "- (none)"}

${episodeBlock(vault, ep)}`,
  };
}

export function matchPrompt(name: string, type: string, ep: Episode, candidates: Entity[], houseRules?: string) {
  return {
    system: withHouseRules(
      `You decide whether a name mentioned in an episode refers to an existing note in a shared memory vault. Answer with the slug of the matching entity, or "new" if none of them is the same real-world thing. Different branches/offices/people with similar names are NOT the same.`,
      houseRules,
    ),
    prompt: `Mention: "${name}" (type: ${type})
Context: ${ep.text.slice(0, 600)}

Candidates:
${candidates.map((c) => `- ${c.slug}: ${displayName(c)} (${c.fm.type}${c.fm.aliases.length ? `; aka ${c.fm.aliases.join(", ")}` : ""})${getSummary(c) ? ` — ${getSummary(c).slice(0, 160)}` : ""}`).join("\n")}`,
  };
}

/** Open questions on `entities`, as `id (slug): question`. */
export function openQuestions(entities: Entity[]): { id: string; slug: string; q: string }[] {
  const out: { id: string; slug: string; q: string }[] = [];
  for (const e of entities) for (const q of e.fm.questions ?? []) if (q.status === "open") out.push({ id: q.id, slug: e.slug, q: q.q });
  return out;
}

export function claimsPrompt(vault: Vault, ep: Episode, entities: Entity[], goals: Entity[], houseRules?: string) {
  const describe = (e: Entity) => {
    // Hidden values (secrets, confidential facts, identity keys) stay masked, as in the summary step:
    // the model needs the field names to reuse, not the values, and its answer may echo what it reads.
    const facts = Object.entries(e.fm.facts)
      .map(([k, f]) => `${k}=${formatValue(f.value, { confidential: isHiddenFact(vault.schema, e.fm.type, k, f) })}`)
      .join("; ");
    return `- ${e.slug} (${e.fm.type}: ${displayName(e)})${facts ? `\n    existing facts: ${facts}` : ""}`;
  };
  const questions = openQuestions(entities);
  const people = owners(vault, []).join(", ");
  return {
    system: withHouseRules(
      `${intro(vault)} Turn one episode into atomic, durable facts.

Rules:
- facts: one attribute per fact, about one of the listed entity slugs only.
  - field: short snake_case (e.g. appointment_date, address, email, phone, status, price_try, deadline). REUSE existing field names when the meaning matches.
  - value: normalized. Dates as YYYY-MM-DD (or YYYY-MM-DDTHH:MM). Resolve relative dates ("next Tuesday") against the report time. Amounts with currency code ("4500 TRY"). IDs, emails, and URLs copied exactly.
  - secret=true for government ID, passport, residence-permit, tax, bank, or card numbers, passwords, and credentials.
  - confidential=true for private details that may be used but shouldn't be repeated (health, money, family matters).
  - scope: only when the value holds in one context (a language, a place, a role); valid_from/valid_until only when stated.
  - Skip speculation, pleasantries, and anything not stated.
- relations: only when the episode states a relationship, using the given vocabulary.
- goals: only for listed goals the episode reports progress on. status="unchanged" unless the episode says otherwise.
- commitments: something someone promised or has to do that isn't a listed goal yet. owner and counterparty only when stated.
- guidelines: only an explicit instruction about how to treat or address an entity ("write to her in Portuguese").${questions.length ? "\n- answered: ids of the open questions the episode answers." : ""}
Return empty lists when nothing applies.`,
      houseRules,
    ),
    prompt: `Report time: ${ep.at}

Entities:
${entities.map(describe).join("\n")}

Goals:
${goals.map((q) => `- ${q.slug}: ${displayName(q)}`).join("\n") || "- (none)"}
${questions.length ? `\nOpen questions:\n${questions.map((q) => `- ${q.id} (${q.slug}): ${q.q}`).join("\n")}\n` : ""}
Relation vocabulary: ${vault.config.relations.join(", ")}
Possible owners: ${people}

${episodeBlock(vault, ep)}`,
  };
}

export function summaryPrompt(vault: Vault, e: Entity, newEvidence: string[], houseRules?: string) {
  // Secret and confidential values (and identity keys) stay masked: a summary is shown everywhere.
  const facts = Object.entries(e.fm.facts)
    .map(([k, f]) => `- ${k}: ${formatValue(f.value, { confidential: isHiddenFact(vault.schema, e.fm.type, k, f) })} (${f.status})`)
    .join("\n");
  const rels = vault
    .neighbors(e.slug)
    .map((n) => `- ${n.dir === "out" ? `${n.rel} → [[${n.entity.slug}]]` : `[[${n.entity.slug}]] ${n.rel} → this`}`)
    .join("\n");
  return {
    system: withHouseRules(
      `You maintain the summary paragraph of a note in a shared memory vault. Write 2–4 plain sentences describing what this entity is and its current state, as of now. Use [[slug]] links for related entities (only slugs given below). Mention disputed or rumored facts as uncertain. Never include values shown as "🔒 secret" or "◐ confidential". No headings, no lists.`,
      houseRules,
    ),
    prompt: `Entity: ${e.slug} — ${displayName(e)} (${e.fm.type})
Previous summary: ${getSummary(e) || "(none)"}

Facts:
${facts || "(none)"}

Relations:
${rels || "(none)"}

New evidence:
${newEvidence.map((t) => `- ${t.slice(0, 500)}`).join("\n")}`,
  };
}
