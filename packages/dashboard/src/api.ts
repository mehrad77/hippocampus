import { EpisodeKind, QuestStatus } from "@hippocampus/core";
import { z } from "zod";
import { HttpError, errorResponse, json, readJson, type ErrorReport, type Guard, type GuardResult } from "./http.ts";
import type { SetupPort } from "./setup.ts";
import { capabilities, type DashboardSource, type SessionInfo, type SetupKind } from "./source.ts";

export interface DashboardApiOptions {
  /** Where the API is mounted, e.g. `/dashboard/api`. */
  basePath: string;
  /** The current source; `undefined` while there is no vault yet (Session Zero). */
  source: () => DashboardSource | undefined | Promise<DashboardSource | undefined>;
  setup?: SetupPort;
  /** The session's `capabilities.setup` when Session Zero is answered elsewhere (the hosted app's own routes). */
  setupKind?: SetupKind;
  guard: Guard;
  /** Where unexpected errors go (default: console.error). */
  report?: ErrorReport;
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

const CuratorBody = z.object({ abort: text(100) });

const IntroductionBody = z.object({
  agent: text(63),
  decision: z.enum(["approve", "dismiss"]),
  title: text(120).optional(),
  lane: z.string().max(500).optional(),
  authority: z.array(text(60)).max(20).optional(),
});

/**
 * The dashboard's JSON API as a web-standard handler, so `hippo dashboard` (node:http) and the
 * Worker serve the same thing. Read routes are GET; actions are JSON POSTs behind the runtime's guard.
 */
export function createDashboardApi(opts: DashboardApiOptions): (request: Request) => Promise<Response> {
  const { basePath, setup } = opts;
  const setupKind = setup?.kind ?? opts.setupKind ?? "none";
  return async (request) => {
    try {
      const url = new URL(request.url);
      if (!url.pathname.startsWith(`${basePath}/`)) throw new HttpError(404, "Not found", "NOT_FOUND");
      const path = url.pathname.slice(basePath.length + 1).replace(/\/+$/, "");
      const method = request.method;
      if (method !== "GET" && method !== "POST") throw new HttpError(405, "Method not allowed", "METHOD");
      const who = await opts.guard(request);
      const body = method === "POST" ? await readJson(request) : undefined;

      if (path === "setup" || path.startsWith("setup/")) {
        if (!setup) throw new HttpError(501, "Setup is not available here", "UNSUPPORTED");
        const sub = path.slice("setup".length).replace(/^\//, "") || "status";
        if (sub === "status" && method === "GET") return json(200, await setup.status());
        return json(200, (await setup.handle(method, sub, body, url)) ?? { ok: true });
      }

      const source = await opts.source();
      if (path === "session" && method === "GET") return json(200, await session(source, setupKind, who, opts.report));
      if (!source) throw new HttpError(409, "No vault yet: finish Session Zero first.", "NO_VAULT");
      const via = who.user ? `@${who.user.login}` : undefined;

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
          case "curator":
            return json(200, await need(source.curator, "the curator's status").status());
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
          case "actions/introduction":
            return json(200, await need(source.introduction, "introductions").call(source, IntroductionBody.parse(body), via));
          case "actions/curator":
            return json(200, await need(source.curator, "aborting sleep runs").abort(CuratorBody.parse(body).abort, via));
        }
      }
      throw new HttpError(404, `No such API route: ${method} ${path}`, "NOT_FOUND");
    } catch (err) {
      return errorResponse(err, opts.report);
    }
  };
}

function need<T>(fn: T | undefined, what: string): T {
  if (!fn) throw new HttpError(501, `This source doesn't support ${what}`, "UNSUPPORTED");
  return fn;
}

async function session(source: DashboardSource | undefined, setup: SetupKind, { user, account }: GuardResult, report?: ErrorReport): Promise<SessionInfo> {
  const caps = capabilities(source, setup);
  const who = { user, ...(account ? { account } : {}) };
  if (!source) return { mode: "setup", ...who, capabilities: caps };
  try {
    return { ...(await source.info()), ...who, capabilities: caps };
  } catch (err) {
    // A vault that can't load (wrong format version, broken config) still gets a session, so the UI can explain.
    const res = errorResponse(err, report);
    const { error, code } = (await res.json()) as { error: string; code: string };
    return { mode: "setup", ...who, capabilities: caps, error: { code, message: error } };
  }
}
