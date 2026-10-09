import type { Actor } from "./audit.ts";

// Git trailers on the commits Hippocampus makes, so `hippo audit` can check each commit against
// what its actor may do. They're claims, not proof: the audit catches bugs and misbehaving models,
// and anyone who can push could forge them anyway.

export const ACTOR_TRAILER = "Hippo-Actor";
export const MODEL_TRAILER = "Hippo-Model";

const TOKEN = /^[A-Za-z0-9-]+$/;

/**
 * `message` with `Key: value` trailers in a final paragraph of their own. Values are flattened to one
 * line, undefined ones are dropped, and a trailer the message already ends with isn't repeated.
 */
export function withTrailers(message: string, trailers: Record<string, string | undefined>): string {
  const body = message.trimEnd();
  const last = body.slice(body.lastIndexOf("\n\n") + 1).split("\n");
  const lines: string[] = [];
  for (const [key, value] of Object.entries(trailers)) {
    if (!TOKEN.test(key)) throw new Error(`invalid trailer key "${key}"`);
    const flat = value?.replace(/\s+/g, " ").trim();
    if (!flat) continue;
    const line = `${key}: ${flat}`;
    if (!last.includes(line) && !lines.includes(line)) lines.push(line);
  }
  return lines.length ? `${body}\n\n${lines.join("\n")}` : message;
}

/** The `Hippo-Actor` value for an actor: `agent:<id>`, `curator`, `human` or `bootstrap`. */
export function actorTrailer(actor: Actor): string {
  return actor.kind === "agent" ? `agent:${actor.id}` : actor.kind;
}

/** The actor a `Hippo-Actor` value names, or undefined for one this version doesn't know. */
export function parseActorTrailer(value: string): Actor | undefined {
  const v = value.trim();
  if (v === "curator" || v === "human" || v === "bootstrap") return { kind: v };
  const agent = /^agent:(.+)$/.exec(v);
  return agent ? { kind: "agent", id: agent[1]!.trim() } : undefined;
}
