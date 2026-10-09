import { EpisodeKind, QuestStatus } from "@hippocampus/core";
import { z } from "zod";
import { HttpError, errorResponse, json, readJson, type Guard } from "./http.ts";
import type { SetupPort } from "./setup.ts";
import { capabilities, type DashboardSource, type SessionInfo } from "./source.ts";

export interface DashboardApiOptions {
  /** Where the API is mounted, e.g. `/dashboard/api`. */
  basePath: string;
  /** The current source; `undefined` while there is no vault yet (Session Zero). */
  source: () => DashboardSource | undefined | Promise<DashboardSource | undefined>;
  setup?: SetupPort;
  guard: Guard;
}

const text = (max: number) => z.string().trim().min(1).max(max);
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}/, "use YYYY-MM-DD");

const RuleBody = z.object({
  dispute: text(200),
  claim: z.number().int().min(0).optional(),
  value: z.string().max(500).optional(),
  pending: z.boolean().optional(),
});

const QuestBody = z.object({
  quest: text(200),
  status: QuestStatus.optional(),
  complete: z.array(text(300)).max(50).optional(),
  reopen: z.array(text(300)).max(50).optional(),
  add: z.array(text(300)).max(50).optional(),
  clock: z
    .object({
      name: text(100),
      segments: z.number().int().min(2).max(12).optional(),
      tick: z.number().int().min(-12).max(12).optional(),
      filled: z.number().int().min(0).max(12).optional(),
      deadline: day.optional(),
    })
    .optional(),
  deadline: day.optional(),
  owner: text(100).optional(),
});

const RememberBody = z.object({
  text: text(8000),
  kind: EpisodeKind.optional(),
  about: z.array(text(200)).max(20).optional(),
  confidence: z.number().min(0).max(1).optional(),
  secret: z.boolean().optional(),
  at: z.string().max(40).optional(),
});

const PartyBody = z.object({
  id: text(63),
  title: text(120),
  lane: z.string().max(500).optional(),
  authority: z.array(text(60)).max(20).optional(),
  host: z.string().max(120).optional(),
});

/**
 * The dashboard's JSON API as a web-standard handler, so `hippo dashboard` (node:http) and the
 * Worker serve the same thing. Read routes are GET; actions are JSON POSTs behind the runtime's guard.
 */
export function createDashboardApi(opts: DashboardApiOptions): (request: Request) => Promise<Response> {
  const { basePath, setup } = opts;
  return async (request) => {
    try {
      const url = new URL(request.url);
      if (!url.pathname.startsWith(`${basePath}/`)) throw new HttpError(404, "Not found", "NOT_FOUND");
      const path = url.pathname.slice(basePath.length + 1).replace(/\/+$/, "");
      const method = request.method;
      if (method !== "GET" && method !== "POST") throw new HttpError(405, "Method not allowed", "METHOD");
      const { user } = await opts.guard(request);
      const body = method === "POST" ? await readJson(request) : undefined;

      if (path === "setup" || path.startsWith("setup/")) {
        if (!setup) throw new HttpError(501, "Setup is not available here", "UNSUPPORTED");
        const sub = path.slice("setup".length).replace(/^\//, "") || "status";
        if (sub === "status" && method === "GET") return json(200, await setup.status());
        return json(200, (await setup.handle(method, sub, body, url)) ?? { ok: true });
      }

      const source = await opts.source();
      if (path === "session" && method === "GET") return json(200, await session(source, setup, user));
      if (!source) throw new HttpError(409, "No vault yet: finish Session Zero first.", "NO_VAULT");
      const via = user ? `@${user.login}` : undefined;

      if (method === "GET") {
        switch (path) {
          case "overview":
            return json(200, await source.overview());
          case "catalog":
            return json(200, await source.catalog());
          case "graph":
            return json(200, await source.graph());
          case "entity":
            return json(200, await source.entity(text(200).parse(url.searchParams.get("ref") ?? "")));
          case "chronicle":
            return json(200, await source.chronicle(url.searchParams.get("month") ?? undefined));
          case "search": {
            const q = text(200).parse(url.searchParams.get("q") ?? "");
            const limit = z.coerce.number().int().min(1).max(20).optional().parse(url.searchParams.get("limit") ?? undefined);
            return json(200, await source.search(q, limit));
          }
        }
      } else {
        switch (path) {
          case "actions/rule": {
            const { dispute, ...choice } = RuleBody.parse(body);
            return json(200, await need(source.rule, "rulings").call(source, dispute, choice, via));
          }
          case "actions/quest": {
            const { quest, ...update } = QuestBody.parse(body);
            return json(200, await need(source.quest, "quest updates").call(source, quest, update));
          }
          case "actions/remember":
            return json(200, await need(source.remember, "remembering").call(source, RememberBody.parse(body)));
          case "actions/party":
            return json(200, await need(source.addParty, "adding party members").call(source, PartyBody.parse(body), via));
        }
      }
      throw new HttpError(404, `No such API route: ${method} ${path}`, "NOT_FOUND");
    } catch (err) {
      return errorResponse(err);
    }
  };
}

function need<T>(fn: T | undefined, what: string): T {
  if (!fn) throw new HttpError(501, `This source doesn't support ${what}`, "UNSUPPORTED");
  return fn;
}

async function session(source: DashboardSource | undefined, setup: SetupPort | undefined, user: { login: string } | undefined): Promise<SessionInfo> {
  const caps = capabilities(source, setup?.kind ?? "none");
  if (!source) return { mode: "setup", user, capabilities: caps };
  try {
    return { ...(await source.info()), user, capabilities: caps };
  } catch (err) {
    // A vault that can't load (wrong format version, broken config) still gets a session, so the UI can explain.
    const res = errorResponse(err);
    const { error, code } = (await res.json()) as { error: string; code: string };
    return { mode: "setup", user, capabilities: caps, error: { code, message: error } };
  }
}
