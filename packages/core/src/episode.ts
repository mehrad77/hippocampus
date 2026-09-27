import { parseDoc, renderDoc } from "./markdown.ts";
import { EpisodeFrontmatter, type EpisodeKind } from "./schema.ts";
import { hash, slugify, ulid } from "./text.ts";

/** A raw memory submitted by an agent, waiting in the inbox for consolidation. */
export interface Episode {
  id: string;
  path: string;
  agent: string;
  kind: EpisodeKind;
  at: string;
  about: string[];
  confidence?: number;
  secret?: boolean;
  text: string;
}

export function parseEpisode(path: string, raw: string, inboxFolder: string, fallbackAt: string): Episode {
  const { data, body } = parseDoc(raw);
  const fm = EpisodeFrontmatter.parse(data);
  const rel = path.startsWith(`${inboxFolder}/`) ? path.slice(inboxFolder.length + 1) : path;
  const agentFromPath = rel.includes("/") ? rel.split("/")[0] : undefined;
  return {
    id: fm.id ?? `ep-${hash(path)}`,
    path,
    agent: (fm.agent ?? agentFromPath ?? "unknown").toLowerCase(),
    kind: fm.kind,
    at: normalizeAt(fm.at) ?? fallbackAt,
    about: fm.about,
    confidence: fm.confidence,
    secret: fm.secret,
    text: body.trim(),
  };
}

function normalizeAt(at: string | undefined): string | undefined {
  if (!at) return undefined;
  const d = new Date(at);
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
}

export interface NewEpisode {
  agent: string;
  text: string;
  kind?: EpisodeKind;
  about?: string[];
  confidence?: number;
  secret?: boolean;
  at?: string;
}

export function createEpisode(inboxFolder: string, input: NewEpisode, now = new Date()): Episode {
  const id = `ep-${ulid(now.getTime())}`;
  const at = normalizeAt(input.at) ?? now.toISOString();
  const agent = slugify(input.agent);
  const stamp = at.slice(0, 19).replace(/:/g, "");
  return {
    id,
    path: `${inboxFolder}/${agent}/${stamp}-${id.slice(-6).toLowerCase()}.md`,
    agent,
    kind: input.kind ?? "observation",
    at,
    about: input.about ?? [],
    confidence: input.confidence,
    secret: input.secret,
    text: input.text.trim(),
  };
}

export function renderEpisode(ep: Episode): string {
  return renderDoc(
    {
      id: ep.id,
      agent: ep.agent,
      kind: ep.kind,
      at: ep.at,
      about: ep.about.length ? ep.about : undefined,
      confidence: ep.confidence,
      secret: ep.secret || undefined,
    },
    `${ep.text}\n`,
  );
}
