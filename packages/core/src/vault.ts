import { CONFIG_PATH, parseConfig } from "./config.ts";
import { VaultError } from "./errors.ts";
import { assertVaultVersion } from "./migrations.ts";
import { basename, displayName, parseEntity, renderEntity, type Entity } from "./entity.ts";
import { parseEpisode, renderEpisode, type Episode } from "./episode.ts";
import { isIntroductionPath, parseIntroduction, renderIntroduction, type Introduction } from "./introduction.ts";
import { parseDoc, renderDoc } from "./markdown.ts";
import { DisputeFrontmatter, type Capability, type Claim, type HippoConfig, type HumanDef } from "./schema.ts";
import { loadSchema, type SchemaRegistry } from "./schema-registry.ts";
import { applyChanges, type Change, type CommitMeta, type VaultStore } from "./store.ts";
import { localParts, normalizeName, parseFactKey, slugify } from "./text.ts";
import { link, unwrapLink } from "./wikilink.ts";

export interface Dispute {
  slug: string;
  path: string;
  fm: DisputeFrontmatter;
  body: string;
}

/**
 * How much weight a source's word carries about one entity or field, highest first: a human whose
 * domains cover it, any other human, an agent with lane authority, anyone else. See reconcile.ts.
 */
export type Authority = "human_domain" | "human" | "authority" | "none";

export interface VaultOptions {
  now?: () => Date;
  /** Load even if the vault format version doesn't match this build (validate/migrate only). */
  skipVersionCheck?: boolean;
}

// Its own module, so modules vault.ts imports can throw it without an import cycle.
export { VaultError };

/** Everything a curator step can change, deep-copied (see `Vault.snapshot`). */
export interface VaultSnapshot {
  readonly entities: Map<string, Entity>;
  readonly disputes: Map<string, Dispute>;
  readonly episodes: Episode[];
  readonly warnings: string[];
  readonly aliasIndex: Map<string, Set<string>>;
  readonly idIndex: Map<string, string>;
  readonly dirty: Set<string>;
  readonly pendingFiles: Map<string, string>;
  readonly removals: Set<string>;
}

/**
 * In-memory model of the vault. Load once, mutate through methods (which track dirty files),
 * then `flush()` to write everything back through the store.
 */
export class Vault {
  readonly entities = new Map<string, Entity>();
  readonly disputes = new Map<string, Dispute>();
  /** Pending inbox episodes, oldest first. */
  episodes: Episode[] = [];
  /** Agents asking to join the party, oldest first. */
  introductions: Introduction[] = [];
  readonly warnings: string[] = [];

  private readonly aliasIndex = new Map<string, Set<string>>();
  private readonly idIndex = new Map<string, string>();
  private readonly dirty = new Set<string>();
  private readonly pendingFiles = new Map<string, string>();
  private readonly removals = new Set<string>();
  private readonly now: () => Date;

  private constructor(
    readonly store: VaultStore,
    readonly config: HippoConfig,
    /** Types and kinds; code asks it for capabilities instead of naming types. */
    readonly schema: SchemaRegistry,
    opts: VaultOptions,
  ) {
    this.now = opts.now ?? (() => new Date());
  }

  static async load(store: VaultStore, opts: VaultOptions = {}): Promise<Vault> {
    const config = parseConfig(await store.read(CONFIG_PATH));
    if (!opts.skipVersionCheck) assertVaultVersion(config);
    const schema = await loadSchema(store, config);
    const vault = new Vault(store, config, schema, opts);
    vault.warnings.push(...schema.warnings);
    await vault.reload();
    return vault;
  }

  async reload(): Promise<void> {
    this.entities.clear();
    this.disputes.clear();
    this.aliasIndex.clear();
    this.idIndex.clear();
    const { folders } = this.config;
    for (const { type, folder } of this.schema.folders()) {
      for (const path of await this.store.list(folder)) {
        if (!path.endsWith(".md")) continue;
        const raw = await this.store.read(path);
        if (raw === undefined) continue;
        try {
          const e = parseEntity(path, raw);
          if (!e.fm.type) e.fm.type = type;
          const clash = this.entities.get(e.slug);
          if (clash) this.warnings.push(`duplicate note name "${e.slug}": ${clash.path} and ${path}; links are ambiguous`);
          this.entities.set(e.slug, e);
          this.indexEntity(e);
        } catch (err) {
          this.warnings.push(`skipped ${path}: ${(err as Error).message}`);
        }
      }
    }
    for (const path of await this.store.list(folders.disputes)) {
      if (!path.endsWith(".md")) continue;
      const { data, body } = parseDoc((await this.store.read(path)) ?? "");
      const parsed = DisputeFrontmatter.safeParse(data);
      if (parsed.success) this.disputes.set(basename(path), { slug: basename(path), path, fm: parsed.data, body });
      else this.warnings.push(`skipped dispute ${path}: ${parsed.error.message}`);
    }
    const fallbackAt = this.now().toISOString();
    const eps: Episode[] = [];
    const intros: Introduction[] = [];
    for (const path of await this.store.list(folders.inbox)) {
      if (isIntroductionPath(path)) {
        const raw = await this.store.read(path);
        try {
          if (raw !== undefined) intros.push(parseIntroduction(path, raw, folders.inbox));
        } catch (err) {
          this.warnings.push(`skipped introduction ${path}: ${(err as Error).message}`);
        }
        continue;
      }
      if (!path.endsWith(".md") || basename(path).startsWith("_") || basename(path) === "README") continue;
      const raw = await this.store.read(path);
      if (raw !== undefined) eps.push(parseEpisode(path, raw, folders.inbox, fallbackAt));
    }
    this.episodes = eps.sort((a, b) => a.at.localeCompare(b.at) || a.path.localeCompare(b.path));
    this.introductions = intros.sort((a, b) => a.at.localeCompare(b.at) || a.path.localeCompare(b.path));
  }

  nowIso(): string {
    return this.now().toISOString();
  }

  // ── Lookup ──────────────────────────────────────────────────────────────────

  private indexEntity(e: Entity): void {
    if (e.fm.id) this.idIndex.set(e.fm.id, e.slug);
    for (const name of [e.slug, e.fm.title, ...e.fm.aliases]) {
      if (!name) continue;
      const key = normalizeName(name);
      if (!key) continue;
      if (!this.aliasIndex.has(key)) this.aliasIndex.set(key, new Set());
      this.aliasIndex.get(key)!.add(e.slug);
    }
  }

  /** Resolve `[[link]]`, slug, id, title, or alias to an entity. Ambiguous aliases return undefined. */
  resolve(ref: string): Entity | undefined {
    const target = unwrapLink(ref);
    const direct = this.entities.get(target) ?? this.entities.get(slugify(target));
    if (direct) return direct;
    const byId = this.idIndex.get(target);
    if (byId) return this.entities.get(byId);
    const hits = this.aliasIndex.get(normalizeName(target));
    if (hits?.size === 1) return this.entities.get([...hits][0]!);
    return undefined;
  }

  /** All entities an alias could refer to. */
  resolveAll(ref: string): Entity[] {
    const one = this.resolve(ref);
    if (one) return [one];
    return [...(this.aliasIndex.get(normalizeName(unwrapLink(ref))) ?? [])].map((s) => this.entities.get(s)!).filter(Boolean);
  }

  ofType(type: string): Entity[] {
    return [...this.entities.values()].filter((e) => e.fm.type === type);
  }

  /** Entities whose type has `cap` (own or inherited). */
  withCapability(cap: Capability): Entity[] {
    return [...this.entities.values()].filter((e) => this.schema.has(e.fm.type, cap));
  }

  /** An agent's note found by any name (for display). Identity and authority use `actorMember`. */
  actor(agent: string): Entity | undefined {
    const e = this.resolve(agent);
    return e && this.schema.has(e.fm.type, "actor") ? e : undefined;
  }

  /** The agent whose slug is exactly `id`: an agent's title or alias never grants its authority. */
  actorMember(id: string): Entity | undefined {
    const e = this.entities.get(id);
    return e && this.schema.has(e.fm.type, "actor") ? e : undefined;
  }

  /** @deprecated Use `actor`. */
  party(agent: string): Entity | undefined {
    return this.actor(agent);
  }

  /** @deprecated Use `actorMember`. */
  partyMember(id: string): Entity | undefined {
    return this.actorMember(id);
  }

  /** Whether `agent` is one of the vault's humans. A missing author, or the generic `human`, is the primary human. */
  isHuman(agent: string | undefined): boolean {
    return agent === undefined || agent === "human" || !!this.human(agent);
  }

  /** The human `id` names (case-insensitive), or the primary human when `id` is missing or the generic `human`. */
  human(id?: string): HumanDef | undefined {
    const humans = this.config.humans;
    if (id === undefined || id === "human") return humans[0];
    const key = id.toLowerCase();
    return humans.find((h) => h.id.toLowerCase() === key);
  }

  /** The human a GitHub login belongs to (their `github:`), else the primary human. */
  humanFor(login: string | undefined): HumanDef {
    const key = login?.toLowerCase();
    return (key && this.config.humans.find((h) => h.github?.toLowerCase() === key)) || this.config.humans[0]!;
  }

  /**
   * How much weight `agent`'s word carries about `entity` (and `field`, a `facts:` key): domains
   * (a human's, or an agent's lane authority) match the entity's tags or type, or the field's `domain`.
   */
  authorityOf(agent: string | undefined, entity: Entity, field?: string): Authority {
    const scope = new Set([...entity.fm.tags.map((t) => t.toLowerCase()), entity.fm.type.toLowerCase()]);
    const fieldDomain = field === undefined ? undefined : this.schema.fieldDef(entity.fm.type, parseFactKey(field).field)?.domain?.toLowerCase();
    const covers = (domains: string[]) => domains.some((d) => scope.has(d.toLowerCase()) || d.toLowerCase() === fieldDomain);
    if (this.isHuman(agent)) return covers(this.human(agent)?.domains ?? []) ? "human_domain" : "human";
    return covers(this.actorMember(agent!)?.fm.authority ?? []) ? "authority" : "none";
  }

  /** Entities linked from or to `slug`. */
  neighbors(slug: string): { rel: string; dir: "out" | "in"; entity: Entity }[] {
    const out: { rel: string; dir: "out" | "in"; entity: Entity }[] = [];
    const self = this.entities.get(slug);
    if (!self) return out;
    for (const r of self.fm.relations) {
      const t = this.resolve(r.target);
      if (t) out.push({ rel: r.rel, dir: "out", entity: t });
    }
    for (const e of this.entities.values()) {
      if (e.slug === slug) continue;
      for (const r of e.fm.relations) if (this.resolve(r.target)?.slug === slug) out.push({ rel: r.rel, dir: "in", entity: e });
    }
    return out;
  }

  // ── Mutation ────────────────────────────────────────────────────────────────

  folderFor(type: string): string {
    const def = this.schema.type(type);
    if (!def) throw new VaultError(`unknown entity type "${type}"; known: ${this.schema.types().map((t) => t.name).join(", ")}`);
    return def.folder;
  }

  uniqueSlug(title: string): string {
    const base = slugify(title);
    let slug = base;
    for (let i = 2; this.entities.has(slug) || this.disputes.has(slug); i++) slug = `${base}-${i}`;
    return slug;
  }

  createEntity(input: { type: string; title: string; aliases?: string[]; tags?: string[]; by?: string; slug?: string }): Entity {
    const slug = input.slug && !this.entities.has(input.slug) ? input.slug : this.uniqueSlug(input.title);
    const aliases = [...new Set([input.title, ...(input.aliases ?? [])])].filter((a) => a && a !== slug);
    const e: Entity = {
      slug,
      path: `${this.folderFor(input.type)}/${slug}.md`,
      fm: {
        id: undefined,
        type: input.type,
        title: input.title,
        aliases,
        tags: [...new Set(input.tags ?? [])],
        relations: [],
        facts: {},
      },
      body: "\n## Notes\n",
    };
    this.entities.set(slug, e);
    this.indexEntity(e);
    this.touch(e, input.by);
    return e;
  }

  addAliases(e: Entity, aliases: string[]): void {
    const known = new Set([e.slug, e.fm.title, ...e.fm.aliases].filter(Boolean).map((a) => normalizeName(a!)));
    const fresh = aliases.filter((a) => a.trim() && !known.has(normalizeName(a)));
    if (!fresh.length) return;
    e.fm.aliases.push(...fresh);
    this.indexEntity(e);
    this.dirty.add(e.path);
  }

  touch(e: Entity, by?: string): void {
    e.fm.updated = this.nowIso();
    e.fm.updated_by = by ?? "curator";
    this.dirty.add(e.path);
  }

  /** Dispute note name for a `facts:` key; a scoped key adds its scope (`dispute-x-greeting-lang-pt`). */
  disputeSlug(entity: string, field: string): string {
    const { field: base, scope } = parseFactKey(field);
    return `dispute-${entity}-${base}${scope ? `-${slugify(scope)}` : ""}`.replace(/_/g, "-");
  }

  openDispute(entity: Entity, field: string, claims: Claim[]): Dispute {
    const slug = this.disputeSlug(entity.slug, field);
    let d = this.disputes.get(slug);
    const now = this.nowIso();
    if (!d) {
      d = {
        slug,
        path: `${this.config.folders.disputes}/${slug}.md`,
        fm: { type: "dispute", entity: link(entity.slug), field, status: "open", claims: [], opened: now },
        body: "",
      };
      this.disputes.set(slug, d);
    }
    if (d.fm.status === "resolved") {
      d.fm.status = "open";
      d.fm.ruling = undefined;
      d.fm.resolved = undefined;
      d.fm.opened = now;
    }
    for (const c of claims) {
      const same = d.fm.claims.find((x) => String(x.value) === String(c.value) && x.by === c.by);
      if (same) same.src = [...new Set([...same.src, ...c.src])];
      else d.fm.claims.push(c);
    }
    d.body = renderDisputeBody(d, displayName(entity));
    this.dirty.add(d.path);
    return d;
  }

  resolveDispute(d: Dispute): void {
    d.fm.status = "resolved";
    d.fm.resolved = this.nowIso();
    this.dirty.add(d.path);
  }

  openDisputes(): Dispute[] {
    return [...this.disputes.values()].filter((d) => d.fm.status === "open");
  }

  /** Write a new episode into the inbox (the `remember` path). */
  addEpisode(ep: Episode): void {
    this.episodes.push(ep);
    this.pendingFiles.set(ep.path, renderEpisode(ep));
  }

  /** Remove a consolidated episode from the inbox. */
  archiveEpisode(ep: Episode): void {
    this.episodes = this.episodes.filter((e) => e.id !== ep.id);
    this.pendingFiles.delete(ep.path);
    this.removals.add(ep.path);
  }

  /** An agent's pending introduction (the newest, if a local tool left several). */
  introductionOf(agent: string): Introduction | undefined {
    return this.introductions.findLast((i) => i.agent === agent);
  }

  /** File an introduction in place of the agent's earlier ones. Returns the paths it replaced. */
  addIntroduction(intro: Introduction): string[] {
    const replaced = this.removeIntroductions(intro.agent);
    this.introductions.push(intro);
    this.writeFile(intro.path, renderIntroduction(intro));
    return replaced;
  }

  /** Withdraw an agent's introductions (approved, dismissed or replaced). Returns their paths. */
  removeIntroductions(agent: string): string[] {
    const gone = this.introductions.filter((i) => i.agent === agent);
    this.introductions = this.introductions.filter((i) => i.agent !== agent);
    for (const i of gone) {
      // One filed in this same batch was never written, so there is nothing to remove.
      if (!this.pendingFiles.delete(i.path)) this.removals.add(i.path);
    }
    return gone.map((i) => i.path);
  }

  chroniclePath(at: string): string {
    const day = localParts(at, this.config.timezone).date;
    return `${this.config.folders.chronicle}/${day.slice(0, 4)}/${day.slice(5, 7)}/${day}.md`;
  }

  /** Append an episode to its day's chronicle as a callout with a block id, so facts can cite it. */
  async appendChronicle(ep: Episode, touched: string[], text = ep.text): Promise<void> {
    const path = this.chroniclePath(ep.at);
    let content = this.pendingFiles.get(path) ?? (await this.store.read(path));
    const { date: day, time } = localParts(ep.at, this.config.timezone);
    if (!content) content = renderDoc({ type: "chronicle", date: day }, `# ${day}\n`);
    if (content.includes(`^${ep.id}\n`) || content.endsWith(`^${ep.id}`)) return;
    const quoted = text
      .split("\n")
      .map((l) => `> ${l}`.trimEnd())
      .join("\n");
    const links = touched.length ? `\n>\n> ↳ ${touched.map((s) => link(s)).join(" · ")}` : "";
    content = `${content.trimEnd()}\n\n> [!episode] ${time} · ${link(ep.agent)} · ${ep.kind}\n${quoted}${links}\n\n^${ep.id}\n`;
    this.pendingFiles.set(path, content);
  }

  /** Link that cites an episode inside its chronicle day. */
  episodeLink(ep: Pick<Episode, "id" | "at">): string {
    return `[[${localParts(ep.at, this.config.timezone).date}#^${ep.id}]]`;
  }

  writeFile(path: string, content: string): void {
    this.pendingFiles.set(path, content);
    this.removals.delete(path);
  }

  markDirty(e: Entity): void {
    this.dirty.add(e.path);
  }

  hasChanges(): boolean {
    return this.dirty.size > 0 || this.pendingFiles.size > 0 || this.removals.size > 0;
  }

  /** A deep copy of all mutable state, so a step that fails halfway can be rolled back with `restore`. */
  snapshot(): VaultSnapshot {
    return structuredClone({
      entities: this.entities,
      disputes: this.disputes,
      episodes: this.episodes,
      warnings: this.warnings,
      aliasIndex: this.aliasIndex,
      idIndex: this.idIndex,
      dirty: this.dirty,
      pendingFiles: this.pendingFiles,
      removals: this.removals,
    });
  }

  restore(snapshot: VaultSnapshot): void {
    // Cloned again so the same snapshot can be restored more than once.
    const s = structuredClone(snapshot);
    const refill = <K, V>(target: Map<K, V>, from: Map<K, V>) => {
      target.clear();
      for (const [k, v] of from) target.set(k, v);
    };
    const refillSet = <T>(target: Set<T>, from: Set<T>) => {
      target.clear();
      for (const v of from) target.add(v);
    };
    refill(this.entities, s.entities);
    refill(this.disputes, s.disputes);
    refill(this.aliasIndex, s.aliasIndex);
    refill(this.idIndex, s.idIndex);
    refill(this.pendingFiles, s.pendingFiles);
    refillSet(this.dirty, s.dirty);
    refillSet(this.removals, s.removals);
    this.episodes = s.episodes;
    this.warnings.splice(0, this.warnings.length, ...s.warnings);
  }

  /** Everything `flush()` would persist, in order. */
  changes(): Change[] {
    const out: Change[] = [];
    const byPath = new Map<string, Entity>([...this.entities.values()].map((e) => [e.path, e]));
    const disputesByPath = new Map<string, Dispute>([...this.disputes.values()].map((d) => [d.path, d]));
    for (const path of this.dirty) {
      const e = byPath.get(path);
      if (e) {
        out.push({ path, content: renderEntity(e) });
        continue;
      }
      const d = disputesByPath.get(path);
      if (d) out.push({ path, content: renderDoc({ ...d.fm }, d.body) });
    }
    for (const [path, content] of this.pendingFiles) out.push({ path, content });
    for (const path of this.removals) out.push({ path, remove: true });
    return out;
  }

  /**
   * Persist all changes as one batch (a single commit on stores that support it).
   * Returns the paths written or removed.
   */
  async flush(meta: CommitMeta = { message: "chore: update vault" }): Promise<string[]> {
    const changes = this.changes();
    await applyChanges(this.store, changes, meta);
    this.dirty.clear();
    this.pendingFiles.clear();
    this.removals.clear();
    return changes.map((c) => c.path);
  }
}

function renderDisputeBody(d: Dispute, entityName: string): string {
  const claims = d.fm.claims
    .map((c) => `- **${c.value}** — ${c.by ? link(c.by) : "human"}${c.at ? ` on ${c.at.slice(0, 10)}` : ""}${c.src.length ? ` (${c.src.join(", ")})` : ""}`)
    .join("\n");
  return `# ⚖ ${entityName} · ${d.fm.field}

Sources disagree about **${d.fm.field}** of ${d.fm.entity}.

${claims}

> [!question] Ruling needed
> Set \`ruling:\` in this note's properties to the correct value, and the next sleep will make it canon.
`;
}
