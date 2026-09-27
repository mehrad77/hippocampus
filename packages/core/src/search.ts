import MiniSearch from "minisearch";
import { displayName, getSummary, type Entity } from "./entity.ts";
import { humanText } from "./markdown.ts";
import { fold } from "./text.ts";
import type { Vault } from "./vault.ts";

interface Doc {
  id: string;
  kind: "entity" | "episode";
  type: string;
  title: string;
  aliases: string;
  text: string;
}

export interface SearchHit {
  id: string;
  kind: "entity" | "episode";
  type: string;
  score: number;
}

function entityText(e: Entity): string {
  const facts = Object.entries(e.fm.facts)
    .filter(([, f]) => !String(f.value).startsWith("secret://"))
    .map(([k, f]) => `${k.replace(/_/g, " ")} ${f.value}`)
    .join(" ");
  return [getSummary(e), facts, e.fm.tags.join(" "), e.fm.lane ?? "", humanText(e.body)].join("\n");
}

/** Full-text index over entities and pending episodes; rebuilt from the vault in milliseconds. */
export class SearchIndex {
  private readonly mini: MiniSearch<Doc>;

  constructor(vault: Vault) {
    this.mini = new MiniSearch<Doc>({
      fields: ["title", "aliases", "text"],
      storeFields: ["kind", "type"],
      processTerm: (term) => fold(term),
      searchOptions: { boost: { title: 3, aliases: 3 }, fuzzy: 0.2, prefix: true, combineWith: "OR" },
    });
    const docs: Doc[] = [];
    for (const e of vault.entities.values()) {
      docs.push({ id: e.slug, kind: "entity", type: e.fm.type, title: displayName(e), aliases: [e.slug, ...e.fm.aliases].join(" "), text: entityText(e) });
    }
    for (const ep of vault.episodes) {
      if (ep.secret) continue;
      docs.push({ id: ep.id, kind: "episode", type: ep.kind, title: "", aliases: ep.about.join(" "), text: ep.text });
    }
    this.mini.addAll(docs);
  }

  search(query: string, opts: { types?: string[]; kind?: "entity" | "episode"; limit?: number } = {}): SearchHit[] {
    const types = opts.types?.length ? new Set(opts.types) : undefined;
    return this.mini
      .search(query, {
        filter: (r) => (!opts.kind || r.kind === opts.kind) && (!types || r.kind !== "entity" || types.has(r.type as string)),
      })
      .slice(0, opts.limit ?? 10)
      .map((r) => ({ id: String(r.id), kind: r.kind as SearchHit["kind"], type: r.type as string, score: r.score }));
  }
}
