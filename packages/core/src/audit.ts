import { actorProps } from "./actor.ts";
import { CONFIG_PATH, CURATOR_RULES_PATH, parseConfig } from "./config.ts";
import { basename, parseEntity, type Entity } from "./entity.ts";
import { parseEpisode } from "./episode.ts";
import { GOAL_KEYS, LEGACY_GOAL_KEYS } from "./goal.ts";
import { HANDBOOK_PATH } from "./handbook.ts";
import { isIntroductionPath } from "./introduction.ts";
import { getRegion, humanText, parseDoc } from "./markdown.ts";
import { AGENT_ID, RESERVED_AGENT_IDS, SELF_CARD_FIELDS } from "./ops.ts";
import { DisputeFrontmatter, type HippoConfig } from "./schema.ts";
import { loadSchema, schemaFolder, type SchemaRegistry } from "./schema-registry.ts";
import { AGE_ARMOR, isSecretRef, secretFieldOf, secretPath } from "./secrets.ts";
import { bufferedStore, type Change, type VaultStore } from "./store.ts";
import { slugify } from "./text.ts";
import { VaultError } from "./vault.ts";
import { REVIEW_PATH } from "./views.ts";
import { unwrapLink } from "./wikilink.ts";

/**
 * Who commits a change set. An agent's `scopes` are its connection's (absent means all, as for local
 * MCP). `migration` rewrites the vault's format: it moves and reshapes notes, never their memory.
 */
export type Actor = { kind: "agent"; id: string; scopes?: string[] } | { kind: "curator" } | { kind: "human" } | { kind: "bootstrap" } | { kind: "migration" };

/** A broken rule. Only the path and the rule, never content: violations end up in logs and errors. */
export interface Violation {
  path: string;
  rule: string;
}

export class AuditError extends VaultError {
  constructor(readonly violations: Violation[]) {
    super(`refused to commit: ${violations.map((v) => `${v.path} (${v.rule})`).join("; ")}`);
  }
}

/** Read-only view of `base` with `changes` applied (the last change to a path wins). */
export function overlayStore(base: VaultStore, changes: Change[]): VaultStore {
  const readOnly = async (): Promise<never> => {
    throw new VaultError("overlay store is read-only");
  };
  return { ...bufferedStore(base, changes).store, write: readOnly, remove: readOnly };
}

type Op = "add" | "modify" | "remove";

interface Layout {
  config: HippoConfig;
  schema: SchemaRegistry;
  inbox: string;
  chronicle: string;
  disputes: string;
  secrets: string;
  /** Type and kind notes: the human's alone, like the config. */
  schemaDir: string;
  /** The entity type whose folder holds `path`, for notes. */
  typeOf(path: string): string | undefined;
}

// CI definitions run with the host's credentials, so nothing but the human edits them (GitHub Actions and GitLab CI).
const PROTECTED = new Set([CONFIG_PATH, CURATOR_RULES_PATH, "AGENTS.md", "CLAUDE.md", ".gitlab-ci.yml"]);
/** The tool's scaffolding a migration may add or rewrite, besides schema notes. */
const SCAFFOLD = ["_hippo/templates", "_hippo/dashboards"];
/** What an agent with the goal scope may change in a goal note's frontmatter. */
const GOAL_EDITABLE = new Set<string>([...GOAL_KEYS, ...LEGACY_GOAL_KEYS, "updated", "updated_by"]);
/** Regions drawn from frontmatter (checked there), and the ones goal edits own. Any other region (the summary) must stay. */
const DERIVED_REGIONS = new Set(["facts", "relations", "guidelines", "decisions", "questions", "stats", "clocks", "progress", "objectives"]);

const under = (path: string, folder: string) => path.startsWith(`${folder}/`);
const dirname = (path: string) => path.slice(0, Math.max(0, path.lastIndexOf("/")));
const squash = (text: string) => text.replace(/\s+/g, " ").trim();

/** JSON with object keys sorted, so equal values compare equal whatever their key order. */
function canonical(v: unknown): string {
  return JSON.stringify(v, (_k, x: unknown) =>
    x && typeof x === "object" && !Array.isArray(x) ? Object.fromEntries(Object.entries(x as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b))) : x,
  );
}

const regionNames = (body: string) => [...body.matchAll(/%% hippo:begin ([\w-]+) %%/g)].map((m) => m[1]!);
const cites = (chronicle: string, id: string) => chronicle.includes(`^${id}\n`) || chronicle.trimEnd().endsWith(`^${id}`);

/** The callout of episode `id` in a chronicle day: from its `[!episode]` header to its `^id`. */
function calloutOf(chronicle: string, id: string): string | undefined {
  const m = new RegExp(`\\^${id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?:\\r?\\n|$)`).exec(chronicle);
  if (!m) return undefined;
  const start = chronicle.lastIndexOf("> [!episode]", m.index);
  return chronicle.slice(Math.max(0, start), m.index);
}

/**
 * How often a secret value appears. Short values (a CVV, a PIN) only count as whole tokens, or every
 * date that contains "026" would block a run; long ones count anywhere, like `redact` does.
 */
function occurrences(text: string, value: string): number {
  if (value.length >= 6) return text.split(value).length - 1;
  const escaped = value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return text.match(new RegExp(`(?<![\\p{L}\\p{N}])${escaped}(?![\\p{L}\\p{N}])`, "gu"))?.length ?? 0;
}

/**
 * Whether a confidential value is distinctive enough to look for in shared text. A year, a floor or a
 * short code (`2026`, `12`, `A4`) turns up in every chronicle's dates and in ordinary prose: counting it
 * would refuse every sleep and redact unrelated words while hiding nothing, so a value is kept out only
 * when it is at least 4 characters and not a short number (under 6 digits), like an identifier is.
 * The curator's redaction uses the same rule, so what it lets through is what the audit accepts.
 */
export function isTrackedConfidential(value: string): boolean {
  const v = value.trim();
  return v.length >= 4 && !/^\d{1,5}$/.test(v);
}

/** A chronicle day without the lines the vault generates (frontmatter, the day's heading, each episode's callout header), whose dates and names aren't leaks. */
function chronicleProse(raw: string): string {
  return raw
    .replace(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/, "")
    .split("\n")
    .filter((line) => !/^# \d{4}-\d{2}-\d{2}\s*$/.test(line) && !/^> \[!episode\] /.test(line))
    .join("\n");
}

/** Whether `id` is one of the vault's humans (a missing author, or the generic `human`, is the primary one). */
function isHumanId(config: HippoConfig, id: string | undefined): boolean {
  if (!id || id === "human") return true;
  const key = id.toLowerCase();
  return config.humans.some((h) => h.id.toLowerCase() === key);
}

function badPath(path: string): boolean {
  return path.startsWith("/") || path.includes("\\") || path.split("/").some((seg) => seg === "" || seg === "." || seg === "..");
}

/**
 * Folders and types as the tree being changed defines them (read from `before`), so a historic
 * commit audits against the layout and schema of its own time.
 */
async function loadLayout(store: VaultStore, config: HippoConfig): Promise<Layout> {
  const schema = await loadSchema(store, config);
  return {
    config,
    ...config.folders,
    schema,
    schemaDir: schemaFolder(config),
    typeOf: (path) => schema.typeAt(path),
  };
}

function curatorPath(path: string, op: Op, l: Layout): string | undefined {
  if (PROTECTED.has(path) || under(path, ".github") || under(path, ".gitlab") || under(path, l.schemaDir)) return "protected file";
  const type = l.typeOf(path);
  if (op === "remove" && isIntroductionPath(path)) return "introductions are the human's to settle";
  if (op === "remove") return under(path, l.inbox) ? undefined : type ? "entity note removed" : "curator may only remove inbox files";
  if (l.schema.has(type, "actor")) return "party note";
  if (type) return undefined;
  if ((under(path, l.disputes) || under(path, l.chronicle)) && path.endsWith(".md")) return undefined;
  if (under(path, l.secrets) && path.endsWith(".age")) return undefined;
  if (path === REVIEW_PATH || path === HANDBOOK_PATH) return undefined;
  return "outside the curator's folders";
}

/** An agent's own party card: a note of an actor type named after it. What it may write there is `auditOwnCard`'s. */
const ownCard = (path: string, id: string, l: Layout) => l.schema.has(l.typeOf(path), "actor") && basename(path) === id && path.endsWith(".md");

function agentPath(path: string, op: Op, id: string, can: (scope: string) => boolean, l: Layout): string | undefined {
  if (op === "add" && can("remember") && dirname(path) === `${l.inbox}/${id}` && path.endsWith(".md")) return undefined;
  // It introduced itself: its card, checked field by field below.
  if (op !== "remove" && can("remember") && ownCard(path, id, l)) return undefined;
  // A new introduction replaces the agent's earlier one; it was never a memory, so nothing is lost.
  if (op === "remove" && can("remember") && dirname(path) === `${l.inbox}/${id}` && isIntroductionPath(path)) return undefined;
  // The scope's wire name is still `quest` (`goal` arrives alongside); it allows editing notes of a goal type.
  if (op !== "remove" && (can("quest") || can("goal")) && (path === HANDBOOK_PATH || (op === "modify" && l.schema.has(l.typeOf(path), "goal")))) return undefined;
  return op === "add" ? "agents only add episodes to their own inbox folder" : `agents may not ${op} this file`;
}

/**
 * Whether `agent`'s card in `store` makes it responsible for anything. Such a name is worth guarding:
 * whoever writes as it writes canon there, and may read confidential details.
 */
export async function hasAuthority(store: VaultStore, agent: string): Promise<boolean> {
  const schema = await loadSchema(store, parseConfig(await store.read(CONFIG_PATH)));
  for (const { type, folder } of schema.folders()) {
    if (!schema.has(type, "actor")) continue;
    const raw = await store.read(`${folder}/${agent}.md`);
    const card = raw === undefined ? undefined : parseNote(`${folder}/${agent}.md`, raw);
    if (card && actorProps(card).authority.length) return true;
  }
  return false;
}

function parseNote(path: string, raw: string): Entity | undefined {
  try {
    return parseEntity(path, raw);
  } catch {
    return undefined;
  }
}

function dispute(raw: string | undefined) {
  if (raw === undefined) return undefined;
  const parsed = DisputeFrontmatter.safeParse(parseDoc(raw).data);
  return parsed.success ? parsed.data : undefined;
}

/**
 * Check a change set against what its actor may do, before it's committed. The human (and vault
 * bootstrap) may change anything. Agents only add episodes to their own inbox folder (and edit goal
 * props with the goal scope). The curator writes canon, but never the human's prose, facts, config or
 * party, never drops a memory, never writes a secret in plain text, and never repeats a confidential
 * value where everyone reads (summaries, names, the chronicle). A migration only reshapes: config,
 * schema, scaffolding, and notes moved or rewritten with the same memory. `forbidden` values (≥3
 * characters, case-sensitive) may not newly appear in anything written, whoever writes it.
 */
export async function auditChanges(i: { before: VaultStore; changes: Change[]; actor: Actor; forbidden?: string[] }): Promise<Violation[]> {
  const { before, actor } = i;
  const out: Violation[] = [];
  const flag = (path: string, rule: string) => {
    if (!out.some((v) => v.path === path && v.rule === rule)) out.push({ path, rule });
  };

  // Only the last change to a path counts, and writes that change nothing aren't changes.
  const was = new Map<string, string | undefined>();
  const changes: Change[] = [];
  for (const c of new Map(i.changes.map((c) => [c.path, c])).values()) {
    const old = await before.read(c.path);
    if ("remove" in c ? old === undefined : old === c.content) continue;
    was.set(c.path, old);
    changes.push(c);
  }

  const leaks = (i.forbidden ?? []).filter((s) => s.trim().length >= 3);
  // A note named after a secret (a model taking an ID for a name) leaks it through the file name and every link.
  const slugs = leaks.map(slugify).filter((s) => s.length >= 6);
  for (const c of changes) {
    if (!("content" in c)) continue;
    if (slugs.some((s) => c.path.toLowerCase().includes(s))) flag(c.path, "path contains a secret value");
    if (leaks.some((s) => occurrences(c.content, s) > occurrences(was.get(c.path) ?? "", s))) flag(c.path, "contains a secret value");
  }
  if (actor.kind === "human" || actor.kind === "bootstrap") return out;

  const config = parseConfig(await before.read(CONFIG_PATH));
  const l = await loadLayout(before, config);
  const after = overlayStore(before, i.changes);
  const op = (c: Change): Op => ("remove" in c ? "remove" : was.get(c.path) === undefined ? "add" : "modify");

  if (actor.kind === "migration") {
    await auditMigration({ l, after, changes, was, op, flag });
    return out;
  }

  if (actor.kind === "agent" && (!AGENT_ID.test(actor.id) || (RESERVED_AGENT_IDS as readonly string[]).includes(actor.id) || isHumanId(config, actor.id))) {
    for (const c of changes) flag(c.path, "not an agent id");
    return out;
  }
  const can = (scope: string) => actor.kind === "agent" && (!actor.scopes || actor.scopes.includes(scope));

  for (const c of changes) {
    if (badPath(c.path)) {
      flag(c.path, "path not normalized");
      continue;
    }
    const rule = actor.kind === "agent" ? agentPath(c.path, op(c), actor.id, can, l) : curatorPath(c.path, op(c), l);
    if (rule) flag(c.path, rule);
  }

  // A human-held fact may change only by a ruling the human wrote, or by the human's own episode.
  const rulings = new Map<string, string>();
  for (const c of changes) {
    if (!under(c.path, l.disputes) || !("content" in c)) continue;
    const [b, a] = [dispute(was.get(c.path)), dispute(c.content)];
    if (b?.status === "open" && a?.status === "resolved" && b.ruling !== undefined && b.ruling !== "") rulings.set(`${unwrapLink(b.entity)}.${b.field}`, String(b.ruling));
  }
  const removed: { path: string; id: string; agent: string; confidential?: string }[] = [];
  for (const c of changes) {
    if (!("remove" in c) || !under(c.path, l.inbox) || isIntroductionPath(c.path)) continue;
    try {
      const ep = parseEpisode(c.path, was.get(c.path)!, l.inbox, new Date(0).toISOString());
      // Enough of a confidential episode's text to recognize it if it shows up in the chronicle.
      const snippet = ep.confidential ? ep.text.trim().split("\n")[0]!.trim().slice(0, 40) : "";
      removed.push({ path: c.path, id: ep.id, agent: ep.agent, ...(snippet.length >= 3 ? { confidential: snippet } : {}) });
    } catch {
      flag(c.path, "removed an unreadable episode");
    }
  }
  const humanEpisodes = new Set(removed.filter((r) => isHumanId(config, r.agent)).map((r) => r.id));

  /**
   * An agent writes its own card when it introduces itself: what it says about itself (its lane, host
   * and model, filled in only where blank), never what it may do. Authority, facts, relations, names and
   * the human's prose stay the human's.
   */
  function auditOwnCard(path: string, b: Entity | undefined, a: Entity): void {
    const fm = (e: Entity) => e.fm as Record<string, unknown>;
    if (!l.schema.has(a.fm.type, "actor")) return flag(path, "agent card of another type");
    if (!b) {
      const authority = fm(a).authority;
      if ((Array.isArray(authority) && authority.length) || (authority !== undefined && !Array.isArray(authority))) flag(path, "an agent can't give itself authority");
      if (Object.keys(a.fm.facts).length || a.fm.relations.length) flag(path, "a new agent card holds no facts or relations");
      return;
    }
    const rest = (e: Entity) => JSON.stringify(Object.entries(fm(e)).filter(([k, v]) => !(SELF_CARD_FIELDS as readonly string[]).includes(k) && v !== undefined).sort(([x], [y]) => x.localeCompare(y)));
    if (rest(a) !== rest(b)) flag(path, "agents may only fill in their card's lane, host and model");
    for (const k of SELF_CARD_FIELDS) if (fm(b)[k] !== undefined && fm(b)[k] !== "" && fm(a)[k] !== fm(b)[k]) flag(path, "agents may not overwrite their card");
    if (squash(humanText(b.body)) !== squash(humanText(a.body))) flag(path, "human prose changed");
  }

  async function auditNote(path: string, oldRaw: string | undefined, raw: string): Promise<void> {
    const a = parseNote(path, raw);
    if (!a) return flag(path, "unreadable note");
    const b = oldRaw === undefined ? undefined : parseNote(path, oldRaw);
    if (oldRaw !== undefined && !b) return flag(path, "overwrites an unreadable note");
    if (actor.kind === "curator" && (l.schema.has(a.fm.type, "actor") || l.schema.has(b?.fm.type, "actor"))) flag(path, "party note");
    if (actor.kind === "agent" && ownCard(path, actor.id, l)) return auditOwnCard(path, b, a);
    if (b) {
      if (actor.kind === "agent") {
        if (!l.schema.has(b.fm.type, "goal")) flag(path, "agents may only edit goal notes");
        else auditGoalEdit(path, b, a, flag);
      }
      const folderType = l.typeOf(path);
      if ((b.fm.type || folderType) !== (a.fm.type || folderType)) flag(path, "entity type changed");
      if ((b.fm.id ?? "") !== (a.fm.id ?? "")) flag(path, "entity id changed");
      if (squash(humanText(b.body)) !== squash(humanText(a.body))) flag(path, "human prose changed");
      for (const [field, f] of Object.entries(b.fm.facts)) {
        if (!isHumanId(config, f.by)) continue;
        const now = a.fm.facts[field];
        if (now && String(now.value) === String(f.value)) continue;
        if (now && rulings.get(`${a.slug}.${field}`) === String(now.value)) continue;
        if (now && isHumanId(config, now.by) && now.src.some((id) => humanEpisodes.has(id))) continue;
        flag(path, `human fact changed: ${field}`);
      }
    }
    // A human-only field takes a value only from a ruling (a proposal's, or a dispute's) or the human's own episode.
    for (const [field, f] of Object.entries(a.fm.facts)) {
      if (!l.schema.fieldDef(a.fm.type, field)?.human_only) continue;
      const prev = b?.fm.facts[field];
      if (prev && String(prev.value) === String(f.value)) continue;
      if (rulings.get(`${a.slug}.${field}`) === String(f.value)) continue;
      if (isHumanId(config, f.by) && f.src.some((id) => humanEpisodes.has(id))) continue;
      flag(path, `human-only field changed: ${field}`);
    }
    for (const [field, f] of Object.entries(a.fm.facts)) {
      const prev = b?.fm.facts[field];
      if (!l.schema.isSecretField(a.fm.type, field) && !isSecretRef(prev?.value) && !isSecretRef(f.value)) continue;
      if (prev && JSON.stringify(prev) === JSON.stringify(f)) continue;
      if (!isSecretRef(f.value)) {
        // A plaintext value the human typed earlier isn't this change's leak.
        if (String(prev?.value) !== String(f.value)) flag(path, `plaintext secret: ${field}`);
      } else if ((await after.read(secretPath(l.secrets, f.value))) === undefined) {
        flag(path, `missing secret file: ${field}`);
      }
    }
  }

  for (const c of changes) {
    if ("content" in c && under(c.path, l.secrets) && c.path.endsWith(".age") && !c.content.startsWith(AGE_ARMOR)) flag(c.path, "secret file is not age ciphertext");
    if (!("content" in c) || badPath(c.path)) continue;
    if (actor.kind === "agent" && op(c) === "add" && under(c.path, l.inbox)) {
      try {
        // The frontmatter `agent` outranks the folder, so it must name the author too.
        if (parseEpisode(c.path, c.content, l.inbox, new Date(0).toISOString()).agent !== actor.id) flag(c.path, "episode filed under another agent");
      } catch {
        flag(c.path, "unreadable episode");
      }
    }
    if (l.typeOf(c.path)) await auditNote(c.path, was.get(c.path), c.content);
  }

  // The ciphertext of a human-held secret changes only with the human's own episode: the note's ref string
  // stays the same, so the fact check above can't see an overwritten value.
  for (const c of changes) {
    if (!("content" in c) || op(c) !== "modify" || !under(c.path, l.secrets) || !c.path.endsWith(".age")) continue;
    const [slug, ...rest] = c.path.slice(l.secrets.length + 1, -".age".length).split("/");
    const field = secretFieldOf(rest.join("/"));
    if (!slug || !field) continue;
    let held = false;
    let covered = false;
    for (const { folder } of l.schema.folders()) {
      const notePath = `${folder}/${slug}.md`;
      const old = await before.read(notePath);
      if (old === undefined) continue;
      const prev = parseNote(notePath, old)?.fm.facts[field];
      held = !!prev && isSecretRef(prev.value) && isHumanId(config, prev.by);
      const change = changes.find((x) => x.path === notePath && "content" in x);
      const now = change && "content" in change ? parseNote(notePath, change.content)?.fm.facts[field] : undefined;
      covered = !!now && isHumanId(config, now.by) && now.src.some((id) => humanEpisodes.has(id));
      break;
    }
    if (held && !covered) flag(c.path, `human secret changed: ${field}`);
  }

  await auditConfidential({ l, before, changes, was, removed, flag });

  // Never lose a memory: a consolidated episode leaves the inbox only once the chronicle cites it.
  let missing = removed.filter((r) => !changes.some((c) => "content" in c && under(c.path, l.chronicle) && cites(c.content, r.id)));
  if (missing.length) {
    for (const path of await after.list(l.chronicle)) {
      const day = (await after.read(path)) ?? "";
      missing = missing.filter((r) => !cites(day, r.id));
      if (!missing.length) break;
    }
  }
  for (const r of missing) flag(r.path, "removed episode not in the chronicle");
  return out;
}

type Flag = (path: string, rule: string) => void;

/**
 * An agent with the goal scope changes goal props (status, progress, due…), objectives and the
 * progress line, never a goal's facts, relations, names, tags or summary.
 */
function auditGoalEdit(path: string, b: Entity, a: Entity, flag: Flag): void {
  const [before, after] = [b.fm as Record<string, unknown>, a.fm as Record<string, unknown>];
  for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
    // Type and id have their own rules.
    if (GOAL_EDITABLE.has(key) || key === "type" || key === "id") continue;
    if (canonical(before[key]) !== canonical(after[key])) flag(path, `agents may only change goal props: ${key}`);
  }
  for (const name of new Set([...regionNames(b.body), ...regionNames(a.body)])) {
    if (DERIVED_REGIONS.has(name)) continue;
    if ((getRegion(b.body, name) ?? "").trim() !== (getRegion(a.body, name) ?? "").trim()) flag(path, `agents may only change goal props: ${name}`);
  }
}

/** Values of a dispute note's confidential claims. */
function confidentialClaims(raw: string | undefined): string[] {
  return (dispute(raw)?.claims ?? []).filter((c) => c.confidential).map((c) => String(c.value).trim()).filter((v) => !isSecretRef(v) && isTrackedConfidential(v));
}

/** Agent text in a note's managed memory: guidelines, decisions, questions (frontmatter and regions) and objectives. */
function managedText(e: Entity | undefined): string {
  if (!e) return "";
  const fm = e.fm;
  return [
    ...(fm.guidelines ?? []).flatMap((g) => [g.rule, g.scope ?? ""]),
    ...(fm.decisions ?? []).flatMap((d) => [d.what, d.why ?? "", ...d.alternatives]),
    ...(fm.questions ?? []).map((q) => q.q),
    ...["guidelines", "decisions", "questions", "objectives"].map((r) => getRegion(e.body, r) ?? ""),
  ].join("\n");
}

/** A fact's value is confidential when the fact says so, or its field is confidential or an identity key. */
function confidentialValues(l: Layout, e: Entity | undefined): string[] {
  if (!e) return [];
  const out: string[] = [];
  for (const [field, f] of Object.entries(e.fm.facts)) {
    const def = l.schema.fieldDef(e.fm.type, field);
    if (!f.confidential && !def?.confidential && !def?.identity_key) continue;
    for (const v of [f.value, ...(f.was ?? []).map((w) => w.value)]) {
      const text = String(v).trim();
      if (!isSecretRef(v) && isTrackedConfidential(text)) out.push(text);
    }
  }
  return out;
}

/**
 * Confidential values must not newly appear in a note's summary, title, aliases or managed memory
 * (guidelines, decisions, questions, objectives), in a dispute note's body, or in the chronicle; nor
 * may a consolidated confidential episode's text appear in its own chronicle entry. The values come
 * from the notes and dispute claims this change set touches, and from every note when it writes a
 * summary, managed memory or the chronicle, which can repeat any of them.
 */
async function auditConfidential(i: {
  l: Layout;
  before: VaultStore;
  changes: Change[];
  was: Map<string, string | undefined>;
  removed: { id: string; confidential?: string }[];
  flag: Flag;
}): Promise<void> {
  const { l, changes, was, flag } = i;
  const summary = (e: Entity | undefined) => (e ? (getRegion(e.body, "summary") ?? "") : "");
  const names = (e: Entity | undefined) => (e ? [e.fm.title ?? "", ...e.fm.aliases].join("\n") : "");
  const notes = changes.filter((c) => l.typeOf(c.path)).map((c) => {
    const old = was.get(c.path);
    return { path: c.path, b: old === undefined ? undefined : parseNote(c.path, old), a: "content" in c ? parseNote(c.path, c.content) : undefined };
  });
  const found = new Set(notes.flatMap((n) => [...confidentialValues(l, n.b), ...confidentialValues(l, n.a)]));
  const disputes = changes.filter((c) => "content" in c && under(c.path, l.disputes));
  for (const c of disputes) for (const v of [...confidentialClaims(was.get(c.path)), ...confidentialClaims("content" in c ? c.content : undefined)]) found.add(v);
  const shared =
    changes.some((c) => "content" in c && under(c.path, l.chronicle)) ||
    notes.some((n) => n.a && (summary(n.a) !== summary(n.b) || managedText(n.a) !== managedText(n.b)));
  if (shared) {
    const paths = new Set((await Promise.all(l.schema.folders().map((t) => i.before.list(t.folder)))).flat());
    for (const path of paths) {
      if (!l.typeOf(path)) continue;
      const raw = await i.before.read(path);
      for (const v of confidentialValues(l, raw === undefined ? undefined : parseNote(path, raw))) found.add(v);
    }
    for (const path of await i.before.list(l.disputes)) for (const v of confidentialClaims(await i.before.read(path))) found.add(v);
  }
  const values = [...found];
  const grew = (now: string, then: string, vs: string[]) => vs.some((v) => occurrences(now, v) > occurrences(then, v));
  if (values.length) {
    for (const { path, b, a } of notes) {
      if (!a) continue;
      if (grew(summary(a), summary(b), values)) flag(path, "confidential value in a summary");
      if (grew(names(a), names(b), values)) flag(path, "confidential value in a title or alias");
      if (grew(managedText(a), managedText(b), values)) flag(path, "confidential value in managed memory");
    }
    for (const c of disputes) {
      if (!("content" in c)) continue;
      const old = was.get(c.path);
      if (grew(parseDoc(c.content).body, old === undefined ? "" : parseDoc(old).body, values)) flag(c.path, "confidential value in a dispute note");
    }
  }
  const episodes = i.removed.filter((r): r is typeof r & { confidential: string } => !!r.confidential);
  for (const c of changes) {
    if (!("content" in c) || !under(c.path, l.chronicle)) continue;
    const then = was.get(c.path) ?? "";
    if (values.length && grew(chronicleProse(c.content), chronicleProse(then), values)) flag(c.path, "confidential value in the chronicle");
    // Only the episode's own entry: another episode may well say the same words in the open.
    if (episodes.some((r) => calloutOf(c.content, r.id)?.includes(r.confidential))) flag(c.path, "confidential episode in the chronicle");
  }
}

/**
 * A format migration only reshapes. It may rewrite the config, add or rewrite schema notes and the
 * handbook, add, rewrite or rename templates and dashboards, move a type folder's `.gitkeep`, and move
 * or rewrite entity notes: a note removed from one type folder comes back at the same path inside
 * the folder of a type with the same name or capability, and every note keeps its human prose, facts,
 * relations, id, names, tags, summary and managed memory. Its type and goal props (v1 `deadline`,
 * `clocks`) may change. Nothing else: not the inbox, chronicle, disputes, secrets, CI or guardrails.
 */
async function auditMigration(i: { l: Layout; after: VaultStore; changes: Change[]; was: Map<string, string | undefined>; op: (c: Change) => Op; flag: Flag }): Promise<void> {
  const { l, changes, was, op, flag } = i;
  // Folders as the migrated tree defines them: notes move into the new type folders.
  const la = await loadLayout(i.after, parseConfig(await i.after.read(CONFIG_PATH)));
  const memory = [l.inbox, l.chronicle, l.disputes, l.secrets, la.inbox, la.chronicle, la.disputes, la.secrets];
  const isNote = (path: string) => path.endsWith(".md") && !memory.some((f) => under(path, f)) && !!(l.typeOf(path) || la.typeOf(path));
  const typeFolder = (path: string) => [...l.schema.folders(), ...la.schema.folders()].some((t) => dirname(path) === t.folder);
  const scaffold = (path: string) => [l.schemaDir, la.schemaDir, ...SCAFFOLD].some((f) => under(path, f));

  const pairs: { path: string; old: string; raw: string }[] = [];
  const removed: { path: string; old: string }[] = [];
  const added: { path: string; raw: string }[] = [];
  for (const c of changes) {
    const o = op(c);
    if (badPath(c.path)) flag(c.path, "path not normalized");
    else if (c.path === CONFIG_PATH || c.path === HANDBOOK_PATH || scaffold(c.path)) {
      // Templates and dashboards named after a v1 type are renamed (removed, then added under the new name).
      if (o === "remove" && !SCAFFOLD.some((f) => under(c.path, f))) flag(c.path, "a migration may not remove this file");
    } else if (o !== "modify" && basename(c.path) === ".gitkeep" && typeFolder(c.path)) {
      // An empty type folder kept in git, or a renamed one's placeholder moving along.
    } else if (isNote(c.path)) {
      if (o === "modify" && "content" in c) pairs.push({ path: c.path, old: was.get(c.path)!, raw: c.content });
      else if (o === "remove") removed.push({ path: c.path, old: was.get(c.path)! });
      else if ("content" in c) added.push({ path: c.path, raw: c.content });
    } else flag(c.path, "a migration may not change this file");
  }
  // A moved note keeps its path inside its type's folder (from/x → to/x), and its type keeps its
  // capability (or its name): a goal and an arc with the same name are two notes, not one.
  const inFolder = (s: SchemaRegistry, path: string) => {
    const folder = s.type(s.typeAt(path))?.folder;
    return folder ? path.slice(folder.length + 1) : path;
  };
  const caps = (s: SchemaRegistry, path: string) => s.type(s.typeAt(path))?.capabilities ?? [];
  const moves = (r: string, a: string) =>
    inFolder(l.schema, r) === inFolder(la.schema, a) && (l.typeOf(r) === la.typeOf(a) || caps(l.schema, r).some((cap) => caps(la.schema, a).includes(cap)));
  const taken = new Set<string>();
  for (const r of removed) {
    const fits = added.filter((a) => !taken.has(a.path) && moves(r.path, a.path));
    if (fits.length > 1) flag(r.path, "duplicate note name");
    const a = fits[0];
    if (!a) {
      flag(r.path, "note removed by a migration");
      continue;
    }
    taken.add(a.path);
    pairs.push({ path: a.path, old: r.old, raw: a.raw });
  }
  for (const a of added) if (!taken.has(a.path)) flag(a.path, "note added by a migration");

  const reshaped = new Set<string>(["type", "updated", "updated_by", ...GOAL_KEYS, ...LEGACY_GOAL_KEYS]);
  for (const { path, old, raw } of pairs) {
    const [b, a] = [parseNote(path, old), parseNote(path, raw)];
    if (!b || !a) {
      flag(path, "unreadable note");
      continue;
    }
    if (squash(humanText(b.body)) !== squash(humanText(a.body))) flag(path, "human prose changed");
    if ((b.fm.id ?? "") !== (a.fm.id ?? "")) flag(path, "entity id changed");
    if ((getRegion(b.body, "summary") ?? "").trim() !== (getRegion(a.body, "summary") ?? "").trim()) flag(path, "summary changed");
    const [fb, fa] = [b.fm as Record<string, unknown>, a.fm as Record<string, unknown>];
    for (const key of new Set([...Object.keys(fb), ...Object.keys(fa)])) {
      if (reshaped.has(key) || key === "id") continue;
      if (canonical(fb[key]) !== canonical(fa[key])) flag(path, key === "facts" || key === "relations" ? `${key} changed` : `frontmatter changed: ${key}`);
    }
  }
}
