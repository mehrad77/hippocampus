import { GOAL_KEYS, goalProps, renderProgress } from "./goal.ts";
import { escapeRegionText, getRegion, humanText, parseDoc, regionLine, renderDoc, setRegion, removeRegion } from "./markdown.ts";
import { EntityFrontmatter, type DecisionEntry, type Fact, type FactValue, type Guideline, type QuestionEntry, type Stats } from "./schema.ts";
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
  "counterparty",
  "due",
  "deadline",
  "progress",
  "repeat",
  "last_done",
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

/** A value for a table or an agent: secrets and confidential values masked, one line, pipes and `%%` escaped. */
export function formatValue(v: FactValue, opts: { confidential?: boolean } = {}): string {
  const s = String(v);
  if (s.startsWith("secret://")) return "🔒 secret";
  if (opts.confidential) return "◐ confidential";
  return regionLine(s).replace(/\|/g, "\\|");
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
      regionLine(scoped ? field : key),
      ...(scoped ? [regionLine(scope ?? "")] : []),
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
  return e.fm.relations.map((r) => `- ${regionLine(r.rel)}:: ${regionLine(link(unwrapLink(r.target)))}`).join("\n");
}

// Every piece of agent text below goes through `regionLine`: one line, no `%%`.
const by = (who: string | undefined) => (who ? regionLine(link(who)) : "human");
const day = (at: string | undefined) => regionLine(at?.slice(0, 10) ?? "");

function renderGuidelines(gs: Guideline[]): string {
  return gs.map((g) => `- ${regionLine(g.rule)}${g.scope ? ` _(${regionLine(g.scope)})_` : ""} · ${STATUS_MARK[g.status] ?? regionLine(g.status)} · ${by(g.by)}`).join("\n");
}

function renderDecisions(ds: DecisionEntry[]): string {
  return ds
    .map((d) => {
      const head = `- **${regionLine(d.what)}**${d.why ? ` — ${regionLine(d.why)}` : ""} · ${by(d.by)}${d.at ? ` · ${day(d.at)}` : ""}`;
      const alts = d.alternatives.length ? `\n  - instead of: ${d.alternatives.map(regionLine).join("; ")}` : "";
      return `${head}${alts}${d.revisit ? `\n  - revisit ${regionLine(d.revisit)}` : ""}`;
    })
    .join("\n");
}

const QUESTION_MARK: Record<string, string> = { open: "[ ]", answered: "[x]", dropped: "[-]" };

function renderQuestions(qs: QuestionEntry[]): string {
  return qs
    .map((q) => {
      const answered = q.status === "answered" ? ` — answered${q.answered_by ? ` by ${link(q.answered_by)}` : ""}${q.answered_at ? ` ${day(q.answered_at)}` : ""}` : "";
      return `- ${QUESTION_MARK[q.status] ?? "[ ]"} ${regionLine(q.q)} · ${by(q.by)}${answered}`;
    })
    .join("\n");
}

function renderStats(st: Stats): string {
  const dates = [st.first_met ? `first met ${day(st.first_met)}` : "", st.last_contact ? `last contact ${day(st.last_contact)}` : ""].filter(Boolean);
  const counts = Object.entries(st.counts)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, n]) => `${regionLine(k)} ×${n}${st.last[k] ? ` (last ${day(st.last[k])})` : ""}`);
  return [dates.length ? `- ${dates.join(" · ")}` : "", ...counts.map((c) => `- ${c}`)].filter(Boolean).join("\n");
}

const hasStats = (st: Stats | undefined): st is Stats => !!st && (!!st.first_met || !!st.last_contact || Object.keys(st.counts).length > 0);

const hasGoalProps = (e: Entity) => GOAL_KEYS.some((k) => k !== "status" && k !== "owner" && (e.fm as Record<string, unknown>)[k] !== undefined);

/**
 * Regenerate derived regions (facts, relations, progress, managed memory) and serialize. Human prose
 * is untouched. `goal` says whether the note's type has the goal capability (the vault knows; without
 * it, a note with goal props counts). A v1 `clocks` region is left as it is for the migration.
 */
export function renderEntity(e: Entity, opts: { goal?: boolean } = {}): string {
  let body = e.body;
  body = Object.keys(e.fm.facts).length ? setRegion(body, "facts", renderFacts(e.fm.facts)) : removeRegion(body, "facts");
  body = e.fm.relations.length ? setRegion(body, "relations", renderRelations(e)) : removeRegion(body, "relations");
  if (opts.goal ?? hasGoalProps(e)) {
    const line = regionLine(renderProgress(goalProps(e)));
    body = line ? setRegion(body, "progress", line) : removeRegion(body, "progress");
  }
  body = e.fm.guidelines?.length ? setRegion(body, "guidelines", renderGuidelines(e.fm.guidelines)) : removeRegion(body, "guidelines");
  body = e.fm.decisions?.length ? setRegion(body, "decisions", renderDecisions(e.fm.decisions)) : removeRegion(body, "decisions");
  body = e.fm.questions?.length ? setRegion(body, "questions", renderQuestions(e.fm.questions)) : removeRegion(body, "questions");
  body = hasStats(e.fm.stats) ? setRegion(body, "stats", renderStats(e.fm.stats)) : removeRegion(body, "stats");
  e.body = body;
  return renderDoc(orderedFrontmatter(e.fm), body);
}

/** The human's own guidelines: the prose under a `## Guidelines` heading, outside managed regions and comments. */
export function getHumanGuidelines(e: Entity): string {
  // Comments hold examples and hints (the people preset's), not rules.
  const prose = humanText(e.body).replace(/<!--[\s\S]*?-->/g, "").replace(/%%[\s\S]*?%%/g, "");
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
  e.body = setRegion(e.body, "summary", escapeRegionText(text.trim()));
}

export function relationTargets(e: Entity): string[] {
  return e.fm.relations.map((r) => unwrapLink(r.target));
}
