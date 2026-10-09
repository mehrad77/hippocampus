import type { IncomingMessage, ServerResponse } from "node:http";
import { fileURLToPath } from "node:url";
import { HippoService } from "@hippocampus/core";
import { FsStore } from "@hippocampus/core/node";
import { createDashboardApi } from "./api.ts";
import { demoSetup } from "./demo-setup.ts";
import { buildDemoStore } from "./demo.ts";
import { HttpError } from "./http.ts";
import { sendResponse, toRequest } from "./node.ts";
import { serviceSource } from "./service-source.ts";
import type { DashboardSource } from "./source.ts";

const SEED = fileURLToPath(new URL("../../../seeds/example-relocation", import.meta.url));

/**
 * The API inside `astro dev`: the demo campaign by default, or a real vault with `HIPPO_VAULT`.
 * Loopback only. A real vault is private data: never commit screenshots or fixtures made from it.
 */
export function devMiddleware(opts: { basePath: string; vaultDir?: string }) {
  let api: Promise<(request: Request) => Promise<Response>> | undefined;
  const build = async () => {
    let source: DashboardSource;
    let setup;
    if (opts.vaultDir) {
      source = serviceSource(new HippoService(new FsStore(opts.vaultDir)), { mode: "local", vault: { kind: "dir", dir: opts.vaultDir } });
    } else {
      const service = new HippoService(await buildDemoStore(new FsStore(SEED)));
      source = serviceSource(service, { mode: "demo", vault: { kind: "memory" } });
      const o = await service.overview();
      setup = demoSetup({ agents: o.party.map((p) => ({ id: p.slug, title: p.title, lastSeen: p.lastSeen })), unknownAgents: o.attention.unknownAgents });
    }
    return createDashboardApi({
      basePath: opts.basePath,
      source: () => source,
      setup,
      guard: (request) => {
        const host = request.headers.get("host") ?? "";
        if (!/^(127\.0\.0\.1|localhost|\[::1\]):\d+$/.test(host)) throw new HttpError(421, "Loopback only", "MISDIRECTED");
        if (request.method !== "GET" && request.headers.get("origin") !== `http://${host}`) throw new HttpError(403, "Cross-origin request refused", "ORIGIN");
        return {};
      },
    });
  };
  return async (req: IncomingMessage & { originalUrl?: string }, res: ServerResponse, next: () => void) => {
    // Astro's dev server strips its `base` from req.url before later middleware run; the original keeps it.
    const url = req.originalUrl ?? req.url ?? "/";
    if (!url.startsWith(`${opts.basePath}/`)) return next();
    req.url = url;
    api ??= build();
    const response = await (await api)(toRequest(req, `http://${req.headers.host ?? "localhost"}`));
    await sendResponse(res, response);
  };
}
