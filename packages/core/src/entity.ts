import { getRegion, parseChecklist, parseDoc, renderChecklist, renderDoc, setRegion, removeRegion, type ChecklistItem } from "./markdown.ts";
import { EntityFrontmatter, type Clock, type Fact, type FactValue } from "./schema.ts";
import { link, unwrapLink } from "./wikilink.ts";

export interface Entity {
  /** Basename without `.md`; unique across the vault (Obsidian resolves links by basename). */
  slug: string;
  path: string;
  fm: EntityFrontmatter;
  body: string;
}

export function basename(path: string): string {
  return (path.split("/").pop() ?? path).replace(/\.md$/, "");
}

export function parseEntity(path: string, raw: string): Entity {
  const { data, body } = parseDoc(raw);
  const fm = EntityFrontmatter.parse(data);
  return { slug: basename(path), path, fm, body };
}

export function displayName(e: Entity): string {
  return e.fm.title ?? e.fm.aliases[0] ?? e.slug;
}

const KEY_ORDER = [
  "id",
  "type",
  "title",
  "aliases",
  "tags",
  "status",
  "owner",
  "deadline",
  "lane",
  "authority",
  "host",
  "clocks",
  "relations",
  "facts",
  "updated",
  "updated_by",
];

function orderedFrontmatter(fm: EntityFrontmatter): Record<string, unknown> {
  const src = fm as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const k of KEY_ORDER) {
    const v = src[k];
    if (v === undefined) continue;
    if (Array.isArray(v) && v.length === 0 && k !== "aliases" && k !== "tags") continue;
    if (k === "facts" && Object.keys(v as object).length === 0) continue;
    out[k] = k === "facts" ? compactFacts(v as Record<string, Fact>) : v;
  }
  for (const [k, v] of Object.entries(src)) if (!(k in out) && !KEY_ORDER.includes(k) && v !== undefined) out[k] = v;
  return out;
}

function compactFacts(facts: Record<string, Fact>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, f] of Object.entries(facts)) {
    const o: Record<string, unknown> = { value: f.value, status: f.status };
    if (f.by) o.by = f.by;
    if (f.at) o.at = f.at;
    if (f.src.length) o.src = f.src;
    if (f.seen_by?.length) o.seen_by = f.seen_by;
    if (f.was?.length) o.was = f.was;
    out[k] = o;
  }
  return out;
}

const STATUS_MARK: Record<string, string> = { canon: "✓ canon", rumor: "? rumor", disputed: "⚠ disputed", retconned: "✗ retconned" };

export function formatValue(v: FactValue): string {
  const s = String(v);
  return s.startsWith("secret://") ? "🔒 secret" : s.replace(/\|/g, "\\|").replace(/\n/g, " ");
}

function renderFacts(facts: Record<string, Fact>): string {
  const rows = Object.entries(facts).map(
    ([k, f]) =>
      `| ${k} | ${formatValue(f.value)} | ${STATUS_MARK[f.status] ?? f.status} | ${f.by ? link(f.by) : "human"} | ${f.at?.slice(0, 10) ?? ""} |`,
  );
  return ["| Fact | Value | Status | By | Since |", "| --- | --- | --- | --- | --- |", ...rows].join("\n");
}

function renderRelations(e: Entity): string {
  // Dataview inline fields (`rel:: [[x]]`) so Obsidian's graph and Dataview both see typed edges.
  return e.fm.relations.map((r) => `- ${r.rel}:: ${link(unwrapLink(r.target))}`).join("\n");
}

export function renderClock(c: Clock): string {
  const filled = Math.min(c.filled, c.segments);
  const bar = "■".repeat(filled) + "□".repeat(c.segments - filled);
  return `- ⏱ **${c.name}** ${bar} ${filled}/${c.segments}${c.deadline ? ` · due ${c.deadline}` : ""}`;
}

/** Regenerate derived regions (facts, relations, clocks) and serialize. Human prose is untouched. */
export function renderEntity(e: Entity): string {
  let body = e.body;
  body = Object.keys(e.fm.facts).length ? setRegion(body, "facts", renderFacts(e.fm.facts)) : removeRegion(body, "facts");
  body = e.fm.relations.length ? setRegion(body, "relations", renderRelations(e)) : removeRegion(body, "relations");
  body = e.fm.clocks?.length ? setRegion(body, "clocks", e.fm.clocks.map(renderClock).join("\n")) : removeRegion(body, "clocks");
  e.body = body;
  return renderDoc(orderedFrontmatter(e.fm), body);
}

export function getSummary(e: Entity): string {
  return getRegion(e.body, "summary")?.trim() ?? "";
}

export function setSummary(e: Entity, text: string): void {
  e.body = setRegion(e.body, "summary", text.trim());
}

// Quest objectives live in the body as a checklist so they can be ticked in Obsidian directly.
export function getObjectives(e: Entity): ChecklistItem[] {
  const region = getRegion(e.body, "objectives");
  return region === undefined ? [] : parseChecklist(region);
}

export function setObjectives(e: Entity, items: ChecklistItem[]): void {
  e.body = setRegion(e.body, "objectives", renderChecklist(items));
}

export function relationTargets(e: Entity): string[] {
  return e.fm.relations.map((r) => unwrapLink(r.target));
}
