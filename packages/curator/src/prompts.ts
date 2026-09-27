import { displayName, formatValue, getSummary, type Entity, type Episode, type HippoConfig, type Vault } from "@hippocampus/core";
import { z } from "zod";

// Every step is a small, strictly-typed call so that small local models cope.

const oneOf = (values: string[]) => z.enum((values.length ? values : ["none"]) as [string, ...string[]]);

export function mentionsSchema(config: HippoConfig) {
  const types = Object.keys(config.types).filter((t) => t !== "party");
  return z.object({
    entities: z.array(
      z.object({
        name: z.string().describe("Most specific proper name, in the original language/spelling"),
        type: oneOf(types),
        aliases: z.array(z.string()).describe("Other spellings, translations, abbreviations mentioned"),
        domains: z.array(z.string()).describe("Applicable domains from the provided list"),
      }),
    ),
  });
}
export type Mentions = z.infer<ReturnType<typeof mentionsSchema>>;

export const matchSchema = (slugs: string[]) =>
  z.object({ match: oneOf([...slugs, "new"]).describe('The slug of the existing entity, or "new"') });

export function claimsSchema(config: HippoConfig, slugs: string[], quests: string[]) {
  return z.object({
    facts: z.array(
      z.object({
        entity: oneOf(slugs),
        field: z.string().describe("snake_case attribute name; reuse an existing field name when the meaning matches"),
        value: z.string().describe("Normalized value: ISO dates, amounts with currency, exact IDs"),
        secret: z.boolean().describe("true for ID/passport/permit/bank/card numbers, passwords, credentials"),
      }),
    ),
    relations: z.array(z.object({ from: oneOf(slugs), rel: oneOf(config.relations), to: oneOf(slugs) })),
    quests: z.array(
      z.object({
        quest: oneOf(quests),
        status: oneOf(["unchanged", "active", "blocked", "done", "failed", "dormant"]),
        completed: z.array(z.string()).describe("Objectives the episode says are now done"),
        added: z.array(z.string()).describe("New objectives/next steps the episode introduces"),
      }),
    ),
  });
}
export type Claims = z.infer<ReturnType<typeof claimsSchema>>;

export const summarySchema = z.object({
  summary: z.string().describe("2–4 sentences, present tense, with [[slug]] links to related entities"),
});

function episodeBlock(ep: Episode): string {
  return `Episode ${ep.id}
Reported by: ${ep.agent}
Kind: ${ep.kind}
Reported at: ${ep.at}${ep.about.length ? `\nAbout (hints): ${ep.about.join(", ")}` : ""}${ep.confidence !== undefined ? `\nConfidence: ${ep.confidence}` : ""}
---
${ep.text}
---`;
}

export function mentionsPrompt(vault: Vault, ep: Episode) {
  const { config } = vault;
  const types = Object.entries(config.types)
    .filter(([t]) => t !== "party")
    .map(([t, d]) => `- ${t}: ${d.description}`)
    .join("\n");
  const quests = vault
    .ofType("quest")
    .map((q) => `- ${displayName(q)}`)
    .join("\n");
  return {
    system: `You are the curator of a campaign wiki that tracks a real person's life ("${config.campaign}") as if it were a tabletop RPG.
Your job in this step: list the entities an episode says something about.

Entity types:
${types}

Rules:
- Include people, organizations, places, documents/items, procedures, and goals that the episode states facts about.
- Do NOT include the reporting agent, dates, times, amounts, or generic nouns ("the office", "an email") as entities.
- If the episode is progress on an existing quest, include that quest by its name.
- name: the most specific proper name as written (keep the original-language spelling). Put translations/abbreviations in aliases.
- domains: choose from [${config.domains.join(", ")}]; empty if none apply.
- Return an empty list if there is nothing durable to remember.`,
    prompt: `Existing quests:
${quests || "- (none)"}

${episodeBlock(ep)}`,
  };
}

export function matchPrompt(name: string, type: string, ep: Episode, candidates: Entity[]) {
  return {
    system: `You decide whether a name mentioned in an episode refers to an existing wiki entity. Answer with the slug of the matching entity, or "new" if none of them is the same real-world thing. Different branches/offices/people with similar names are NOT the same.`,
    prompt: `Mention: "${name}" (type: ${type})
Context: ${ep.text.slice(0, 600)}

Candidates:
${candidates.map((c) => `- ${c.slug}: ${displayName(c)} (${c.fm.type}${c.fm.aliases.length ? `; aka ${c.fm.aliases.join(", ")}` : ""})${getSummary(c) ? ` — ${getSummary(c).slice(0, 160)}` : ""}`).join("\n")}`,
  };
}

export function claimsPrompt(vault: Vault, ep: Episode, entities: Entity[], quests: Entity[]) {
  const describe = (e: Entity) => {
    const facts = Object.entries(e.fm.facts)
      .map(([k, f]) => `${k}=${formatValue(f.value)}`)
      .join("; ");
    return `- ${e.slug} (${e.fm.type}: ${displayName(e)})${facts ? `\n    existing facts: ${facts}` : ""}`;
  };
  return {
    system: `You are the curator of a campaign wiki tracking a real person's life. Turn one episode into atomic, durable facts.

Rules:
- facts: one attribute per fact, about one of the listed entity slugs only.
  - field: short snake_case (e.g. appointment_date, address, email, phone, status, price_try, deadline). REUSE existing field names when the meaning matches.
  - value: normalized. Dates as YYYY-MM-DD (or YYYY-MM-DDTHH:MM). Resolve relative dates ("next Tuesday") against the report time. Amounts with currency code ("4500 TRY"). IDs, emails, and URLs copied exactly.
  - secret=true for government ID, passport, residence-permit, tax, bank, or card numbers, passwords, and credentials.
  - Skip speculation, pleasantries, and anything not stated.
- relations: only when the episode states a relationship, using the given vocabulary.
- quests: only for listed quests the episode reports progress on. status="unchanged" unless the episode says otherwise.
Return empty lists when nothing applies.`,
    prompt: `Report time: ${ep.at}

Entities:
${entities.map(describe).join("\n")}

Quests:
${quests.map((q) => `- ${q.slug}: ${displayName(q)}`).join("\n") || "- (none)"}

Relation vocabulary: ${vault.config.relations.join(", ")}

${episodeBlock(ep)}`,
  };
}

export function summaryPrompt(vault: Vault, e: Entity, newEvidence: string[]) {
  const facts = Object.entries(e.fm.facts)
    .map(([k, f]) => `- ${k}: ${formatValue(f.value)} (${f.status})`)
    .join("\n");
  const rels = vault
    .neighbors(e.slug)
    .map((n) => `- ${n.dir === "out" ? `${n.rel} → [[${n.entity.slug}]]` : `[[${n.entity.slug}]] ${n.rel} → this`}`)
    .join("\n");
  return {
    system: `You maintain the summary paragraph of a campaign-wiki note. Write 2–4 plain sentences describing what this entity is and its current state, as of now. Use [[slug]] links for related entities (only slugs given below). Mention disputed or rumored facts as uncertain. Never include values shown as "🔒 secret". No headings, no lists.`,
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
