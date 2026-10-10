import { getRegion, humanText, parseChecklist, parseDoc, renderChecklist, renderDoc, setRegion, removeRegion, type ChecklistItem } from "./markdown.ts";
import { EntityFrontmatter, type Clock, type DecisionEntry, type Fact, type FactValue, type Guideline, type QuestionEntry, type Stats } from "./schema.ts";
import { parseFactKey } from "./text.ts";
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
  "extends",
  "cadence",
  "defaults",
  "relations",
  "facts",
  "guidelines",
  "decisions",
  "questions",
  "stats",
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
    if ((k === "facts" || k === "defaults") && Object.keys(v as object).length === 0) continue;
    out[k] = k === "facts" ? compactFacts(v as Record<string, Fact>) : MANAGED_LISTS.has(k) ? (v as object[]).map(compact) : k === "stats" ? compactStats(v as Stats) : v;
  }
  for (const [k, v] of Object.entries(src)) if (!(k in out) && !KEY_ORDER.includes(k) && v !== undefined) out[k] = v;
  return out;
}

const MANAGED_LISTS = new Set(["guidelines", "decisions", "questions"]);

/** Undefined keys and empty lists left out, so managed entries stay short in the frontmatter. */
function compact(o: object): Record<string, unknown> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined && !(Array.isArray(v) && v.length === 0)));
}

function compactStats(st: Stats): Record<string, unknown> {
  return compact({
    first_met: st.first_met,
    last_contact: st.last_contact,
    last: Object.keys(st.last).length ? st.last : undefined,
    counts: Object.keys(st.counts).length ? st.counts : undefined,
  });
}

function compactFacts(facts: Record<string, Fact>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, f] of Object.entries(facts)) {
    const o: Record<string, unknown> = { value: f.value, status: f.status };
    if (f.by) o.by = f.by;
    if (f.at) o.at = f.at;
    if (f.src.length) o.src = f.src;
    if (f.seen_by?.length) o.seen_by = f.seen_by;
    if (f.valid_from) o.valid_from = f.valid_from;
    if (f.valid_until) o.valid_until = f.valid_until;
    if (f.confidence !== undefined) o.confidence = f.confidence;
    if (f.confidential) o.confidential = true;
    if (f.was?.length) o.was = f.was.map((w) => Object.fromEntries(Object.entries(w).filter(([, v]) => v !== undefined)));
    out[k] = o;
  }
  return out;
}

const STATUS_MARK: Record<string, string> = { canon: "✓ canon", rumor: "? rumor", disputed: "⚠ disputed", retconned: "✗ retconned" };

/** A value for a table or an agent: secrets and confidential values masked, pipes escaped. */
export function formatValue(v: FactValue, opts: { confidential?: boolean } = {}): string {
  const s = String(v);
  if (s.startsWith("secret://")) return "🔒 secret";
  if (opts.confidential) return "◐ confidential";
  return s.replace(/\|/g, "\\|").replace(/\n/g, " ");
}

/** `2024-01 → 2026-03`, `since 2024-01`, `until 2026-03`, or empty. */
export function formatValidity(f: { valid_from?: string; valid_until?: string }): string {
  const [from, until] = [f.valid_from?.slice(0, 10), f.valid_until?.slice(0, 10)];
  if (from && until) return `${from} → ${until}`;
  if (from) return `since ${from}`;
  return until ? `until ${until}` : "";
}

// Scope and Valid columns appear only when some fact uses them, so plain notes keep their table.
function renderFacts(facts: Record<string, Fact>): string {
  const entries = Object.entries(facts).map(([k, f]) => ({ ...parseFactKey(k), key: k, f }));
  const scoped = entries.some((e) => e.scope);
  const dated = entries.some((e) => e.f.valid_from || e.f.valid_until);
  const head = ["Fact", ...(scoped ? ["Scope"] : []), "Value", "Status", "By", "Since", ...(dated ? ["Valid"] : [])];
  const rows = entries.map(({ field, scope, key, f }) => {
    const cells = [
      scoped ? field : key,
      ...(scoped ? [scope ?? ""] : []),
      formatValue(f.value, { confidential: f.confidential }),
      STATUS_MARK[f.status] ?? f.status,
      f.by ? link(f.by) : "human",
      f.at?.slice(0, 10) ?? "",
      ...(dated ? [formatValidity(f)] : []),
    ];
    return `| ${cells.join(" | ")} |`;
  });
  return [`| ${head.join(" | ")} |`, `| ${head.map(() => "---").join(" | ")} |`, ...rows].join("\n");
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

const by = (who: string | undefined) => (who ? link(who) : "human");
const day = (at: string | undefined) => at?.slice(0, 10) ?? "";

function renderGuidelines(gs: Guideline[]): string {
  return gs.map((g) => `- ${g.rule.replace(/\n/g, " ")}${g.scope ? ` _(${g.scope})_` : ""} · ${STATUS_MARK[g.status] ?? g.status} · ${by(g.by)}`).join("\n");
}

function renderDecisions(ds: DecisionEntry[]): string {
  return ds
    .map((d) => {
      const head = `- **${d.what.replace(/\n/g, " ")}**${d.why ? ` — ${d.why.replace(/\n/g, " ")}` : ""} · ${by(d.by)}${d.at ? ` · ${day(d.at)}` : ""}`;
      const alts = d.alternatives.length ? `\n  - instead of: ${d.alternatives.join("; ")}` : "";
      return `${head}${alts}${d.revisit ? `\n  - revisit ${d.revisit}` : ""}`;
    })
    .join("\n");
}

const QUESTION_MARK: Record<string, string> = { open: "[ ]", answered: "[x]", dropped: "[-]" };

function renderQuestions(qs: QuestionEntry[]): string {
  return qs
    .map((q) => {
      const answered = q.status === "answered" ? ` — answered${q.answered_by ? ` by ${link(q.answered_by)}` : ""}${q.answered_at ? ` ${day(q.answered_at)}` : ""}` : "";
      return `- ${QUESTION_MARK[q.status] ?? "[ ]"} ${q.q.replace(/\n/g, " ")} · ${by(q.by)}${answered}`;
    })
    .join("\n");
}

function renderStats(st: Stats): string {
  const dates = [st.first_met ? `first met ${st.first_met}` : "", st.last_contact ? `last contact ${st.last_contact}` : ""].filter(Boolean);
  const counts = Object.entries(st.counts)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, n]) => `${k} ×${n}${st.last[k] ? ` (last ${st.last[k]})` : ""}`);
  return [dates.length ? `- ${dates.join(" · ")}` : "", ...counts.map((c) => `- ${c}`)].filter(Boolean).join("\n");
}

const hasStats = (st: Stats | undefined): st is Stats => !!st && (!!st.first_met || !!st.last_contact || Object.keys(st.counts).length > 0);

/** Regenerate derived regions (facts, relations, clocks, managed memory) and serialize. Human prose is untouched. */
export function renderEntity(e: Entity): string {
  let body = e.body;
  body = Object.keys(e.fm.facts).length ? setRegion(body, "facts", renderFacts(e.fm.facts)) : removeRegion(body, "facts");
  body = e.fm.relations.length ? setRegion(body, "relations", renderRelations(e)) : removeRegion(body, "relations");
  body = e.fm.clocks?.length ? setRegion(body, "clocks", e.fm.clocks.map(renderClock).join("\n")) : removeRegion(body, "clocks");
  body = e.fm.guidelines?.length ? setRegion(body, "guidelines", renderGuidelines(e.fm.guidelines)) : removeRegion(body, "guidelines");
  body = e.fm.decisions?.length ? setRegion(body, "decisions", renderDecisions(e.fm.decisions)) : removeRegion(body, "decisions");
  body = e.fm.questions?.length ? setRegion(body, "questions", renderQuestions(e.fm.questions)) : removeRegion(body, "questions");
  body = hasStats(e.fm.stats) ? setRegion(body, "stats", renderStats(e.fm.stats)) : removeRegion(body, "stats");
  e.body = body;
  return renderDoc(orderedFrontmatter(e.fm), body);
}

/** The human's own guidelines: the prose under a `## Guidelines` heading, outside managed regions. */
export function getHumanGuidelines(e: Entity): string {
  const prose = humanText(e.body);
  const m = /^##[ \t]+Guidelines[ \t]*$/im.exec(prose);
  if (!m) return "";
  const rest = prose.slice(m.index + m[0].length);
  const next = /^#{1,2}[ \t]/m.exec(rest);
  return (next ? rest.slice(0, next.index) : rest).trim();
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
