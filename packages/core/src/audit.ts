import { CONFIG_PATH, CURATOR_RULES_PATH, parseConfig } from "./config.ts";
import { parseEntity, type Entity } from "./entity.ts";
import { parseEpisode } from "./episode.ts";
import { HANDBOOK_PATH } from "./handbook.ts";
import { isIntroductionPath } from "./introduction.ts";
import { humanText, parseDoc } from "./markdown.ts";
import { AGENT_ID, RESERVED_AGENT_IDS } from "./ops.ts";
import { DisputeFrontmatter, type HippoConfig } from "./schema.ts";
import { isSecretRef, secretPath } from "./secrets.ts";
import type { Change, VaultStore } from "./store.ts";
import { slugify } from "./text.ts";
import { VaultError } from "./vault.ts";
import { REVIEW_PATH } from "./views.ts";
import { unwrapLink } from "./wikilink.ts";

/** Who commits a change set. An agent's `scopes` are its connection's (absent means all, as for local MCP). */
export type Actor = { kind: "agent"; id: string; scopes?: string[] } | { kind: "curator" } | { kind: "human" } | { kind: "bootstrap" };

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
  const over = new Map(changes.map((c) => [c.path, "remove" in c ? undefined : c.content] as const));
  const readOnly = async (): Promise<never> => {
    throw new VaultError("overlay store is read-only");
  };
  return {
    async list(prefix = "") {
      const dir = prefix && !prefix.endsWith("/") ? `${prefix}/` : prefix;
      const paths = new Set(await base.list(prefix));
      for (const [path, content] of over) {
        if (content === undefined) paths.delete(path);
        else if (path.startsWith(dir)) paths.add(path);
      }
      return [...paths].sort();
    },
    read: async (path) => (over.has(path) ? over.get(path) : base.read(path)),
    write: readOnly,
    remove: readOnly,
  };
}

type Op = "add" | "modify" | "remove";

interface Layout {
  config: HippoConfig;
  inbox: string;
  chronicle: string;
  disputes: string;
  secrets: string;
  /** The entity type whose folder holds `path`, for notes. */
  typeOf(path: string): string | undefined;
}

const PROTECTED = new Set([CONFIG_PATH, CURATOR_RULES_PATH, "AGENTS.md", "CLAUDE.md"]);
const AGE_ARMOR = "-----BEGIN AGE ENCRYPTED FILE-----";

const under = (path: string, folder: string) => path.startsWith(`${folder}/`);
const dirname = (path: string) => path.slice(0, Math.max(0, path.lastIndexOf("/")));
const squash = (text: string) => text.replace(/\s+/g, " ").trim();
const cites = (chronicle: string, id: string) => chronicle.includes(`^${id}\n`) || chronicle.trimEnd().endsWith(`^${id}`);

/**
 * How often a secret value appears. Short values (a CVV, a PIN) only count as whole tokens, or every
 * date that contains "026" would block a run; long ones count anywhere, like `redact` does.
 */
function occurrences(text: string, value: string): number {
  if (value.length >= 6) return text.split(value).length - 1;
  const escaped = value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return text.match(new RegExp(`(?<![\\p{L}\\p{N}])${escaped}(?![\\p{L}\\p{N}])`, "gu"))?.length ?? 0;
}

function isHumanId(config: HippoConfig, id: string | undefined): boolean {
  return !id || id === "human" || id.toLowerCase() === config.human.toLowerCase();
}

function badPath(path: string): boolean {
  return path.startsWith("/") || path.includes("\\") || path.split("/").some((seg) => seg === "" || seg === "." || seg === "..");
}

function layout(config: HippoConfig): Layout {
  // Longest folder first, so a nested type folder wins over its parent.
  const folders = Object.entries(config.types)
    .map(([type, def]) => ({ type, folder: def.folder }))
    .sort((a, b) => b.folder.length - a.folder.length);
  return {
    config,
    ...config.folders,
    typeOf: (path) => (path.endsWith(".md") ? folders.find((f) => under(path, f.folder))?.type : undefined),
  };
}

function curatorPath(path: string, op: Op, l: Layout): string | undefined {
  if (PROTECTED.has(path) || under(path, ".github")) return "protected file";
  const type = l.typeOf(path);
  if (op === "remove" && isIntroductionPath(path)) return "introductions are the human's to settle";
  if (op === "remove") return under(path, l.inbox) ? undefined : type ? "entity note removed" : "curator may only remove inbox files";
  if (type === "party") return "party note";
  if (type) return undefined;
  if ((under(path, l.disputes) || under(path, l.chronicle)) && path.endsWith(".md")) return undefined;
  if (under(path, l.secrets) && path.endsWith(".age")) return undefined;
  if (path === REVIEW_PATH || path === HANDBOOK_PATH) return undefined;
  return "outside the curator's folders";
}

function agentPath(path: string, op: Op, id: string, can: (scope: string) => boolean, l: Layout): string | undefined {
  if (op === "add" && can("remember") && dirname(path) === `${l.inbox}/${id}` && path.endsWith(".md")) return undefined;
  // A new introduction replaces the agent's earlier one; it was never a memory, so nothing is lost.
  if (op === "remove" && can("remember") && dirname(path) === `${l.inbox}/${id}` && isIntroductionPath(path)) return undefined;
  if (op !== "remove" && can("quest") && (path === HANDBOOK_PATH || (op === "modify" && l.typeOf(path) === "quest"))) return undefined;
  return op === "add" ? "agents only add episodes to their own inbox folder" : `agents may not ${op} this file`;
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
 * bootstrap) may change anything. Agents only add episodes to their own inbox folder (and edit quests
 * with the `quest` scope). The curator writes canon, but never the human's prose, facts, config or
 * party, never drops a memory, and never writes a secret in plain text. `forbidden` values (≥3
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
  const l = layout(config);
  const after = overlayStore(before, i.changes);
  const op = (c: Change): Op => ("remove" in c ? "remove" : was.get(c.path) === undefined ? "add" : "modify");

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
  const removed: { path: string; id: string; agent: string }[] = [];
  for (const c of changes) {
    if (!("remove" in c) || !under(c.path, l.inbox) || isIntroductionPath(c.path)) continue;
    try {
      const ep = parseEpisode(c.path, was.get(c.path)!, l.inbox, new Date(0).toISOString());
      removed.push({ path: c.path, id: ep.id, agent: ep.agent });
    } catch {
      flag(c.path, "removed an unreadable episode");
    }
  }
  const humanEpisodes = new Set(removed.filter((r) => isHumanId(config, r.agent)).map((r) => r.id));

  async function auditNote(path: string, oldRaw: string | undefined, raw: string): Promise<void> {
    const a = parseNote(path, raw);
    if (!a) return flag(path, "unreadable note");
    const b = oldRaw === undefined ? undefined : parseNote(path, oldRaw);
    if (oldRaw !== undefined && !b) return flag(path, "overwrites an unreadable note");
    if (actor.kind === "curator" && (a.fm.type === "party" || b?.fm.type === "party")) flag(path, "party note");
    if (b) {
      if (actor.kind === "agent" && b.fm.type !== "quest") flag(path, "agents may only edit quest notes");
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
    const secretFields = config.types[a.fm.type]?.secret_fields ?? [];
    for (const [field, f] of Object.entries(a.fm.facts)) {
      const prev = b?.fm.facts[field];
      if (!secretFields.includes(field) && !isSecretRef(prev?.value) && !isSecretRef(f.value)) continue;
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
