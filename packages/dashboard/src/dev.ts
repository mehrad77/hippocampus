import type { IncomingMessage, ServerResponse } from "node:http";
import { fileURLToPath } from "node:url";
import { HippoService } from "@hippocampus/core";
import { FsStore } from "@hippocampus/core/node";
import { createDashboardApi } from "./api.ts";
import { demoSetup } from "./demo-setup.ts";
import { hostedDemo } from "./demo-hosted.ts";
import { buildDemoStore } from "./demo.ts";
import { HttpError, errorResponse } from "./http.ts";
import { sendResponse, toRequest } from "./node.ts";
import { serviceSource } from "./service-source.ts";
import type { DashboardSource } from "./source.ts";

const SEED = fileURLToPath(new URL("../../../seeds/example-relocation", import.meta.url));

/**
 * The API inside `astro dev`: the demo campaign by default, or a real vault with `HIPPO_VAULT`.
 * `hosted` (or HIPPO_DEMO_HOSTED=1) puts the hosted app's sign-in and onboarding in front of the demo
 * (demo-hosted.ts), starting signed out. Loopback only. A real vault is private data: never commit
 * screenshots or fixtures made from it.
 */
export function devMiddleware(opts: { basePath: string; vaultDir?: string; hosted?: boolean }) {
  const hosted = !opts.vaultDir && (opts.hosted ?? process.env.HIPPO_DEMO_HOSTED === "1");
  // The dashboard's own base (`/dashboard`): sign-in lives next to the API there, as on the Worker.
  const site = opts.basePath.replace(/\/api$/, "");
  const guard = (request: Request) => {
    const host = request.headers.get("host") ?? "";
    if (!/^(127\.0\.0\.1|localhost|\[::1\]):\d+$/.test(host)) throw new HttpError(421, "Loopback only", "MISDIRECTED");
    if (request.method !== "GET" && request.headers.get("origin") !== `http://${host}`) throw new HttpError(403, "Cross-origin request refused", "ORIGIN");
    return {};
  };
  let app: Promise<(request: Request) => Promise<Response | undefined>> | undefined;
  const build = async () => {
    let source: DashboardSource;
    let setup;
    if (opts.vaultDir) {
      source = serviceSource(new HippoService(new FsStore(opts.vaultDir)), { mode: "local", vault: { kind: "dir", dir: opts.vaultDir } });
    } else {
      const service = new HippoService(await buildDemoStore(new FsStore(SEED)));
      source = serviceSource(service, { mode: "demo", vault: { kind: "memory" } });
      const o = await service.overview();
      if (!hosted) setup = demoSetup({ agents: o.party.map((p) => ({ id: p.slug, title: p.title, lastSeen: p.lastSeen })), unknownAgents: o.attention.unknownAgents });
    }
    const api = createDashboardApi({ basePath: opts.basePath, source: () => source, setup, guard });
    if (!hosted) return api;
    const demo = hostedDemo({ base: site, source });
    return async (request: Request) => {
      try {
        guard(request);
      } catch (err) {
        return errorResponse(err);
      }
      return (await demo(request)) ?? (new URL(request.url).pathname.startsWith(`${opts.basePath}/`) ? api(request) : undefined);
    };
  };
  return async (req: IncomingMessage & { originalUrl?: string }, res: ServerResponse, next: () => void) => {
    // Astro's dev server strips its `base` from req.url before later middleware run; the original keeps it.
    const url = req.originalUrl ?? req.url ?? "/";
    const path = url.split("?")[0] ?? url;
    const mine = path.startsWith(`${opts.basePath}/`) || (hosted && (path.startsWith(`${site}/auth/`) || path === `${site}/` || path === site));
    if (!mine) return next();
    req.url = url;
    app ??= build();
    const response = await (await app)(toRequest(req, `http://${req.headers.host ?? "localhost"}`));
    if (!response) return next();
    await sendResponse(res, response);
  };
}
