import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sendResponse, serveStatic, toRequest } from "./node.ts";

describe("serveStatic", () => {
  let dir: string;
  let root: string;
  const serve = (path: string, method = "GET") => serveStatic(root, "/dashboard", new Request(`http://127.0.0.1:4100${path}`, { method }));

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "hippo-static-"));
    root = join(dir, "dist");
    // Outside the served root: must never be reachable.
    await writeFile(join(dir, "package.json"), '{"name":"outside"}');
    await mkdir(join(root, "council"), { recursive: true });
    await mkdir(join(root, "_astro"), { recursive: true });
    await writeFile(join(root, "index.html"), "<h1>Home</h1>");
    await writeFile(join(root, "council", "index.html"), "<h1>Council</h1>");
    await writeFile(join(root, "_astro", "app.abc123.js"), "console.log(1)");
    await writeFile(join(root, "favicon.svg"), "<svg/>");
    await writeFile(join(root, "data.bin"), "x");
  });
  afterAll(() => rm(dir, { recursive: true, force: true }));

  it("serves index.html for directory URLs", async () => {
    for (const path of ["/dashboard/", "/dashboard"]) {
      const res = (await serve(path))!;
      expect(res.status).toBe(200);
      expect(await res.text()).toBe("<h1>Home</h1>");
    }
    for (const path of ["/dashboard/council/", "/dashboard/council"]) expect(await (await serve(path))!.text()).toBe("<h1>Council</h1>");
  });

  it("sets content type, cache and security headers", async () => {
    const page = (await serve("/dashboard/"))!;
    expect(page.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(page.headers.get("cache-control")).toBe("no-cache");
    expect(page.headers.get("content-length")).toBe("13");
    expect(page.headers.get("x-content-type-options")).toBe("nosniff");
    expect(page.headers.get("content-security-policy")).toBe("frame-ancestors 'none'");

    const asset = (await serve("/dashboard/_astro/app.abc123.js"))!;
    expect(asset.headers.get("content-type")).toBe("text/javascript; charset=utf-8");
    expect(asset.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    expect(await asset.text()).toBe("console.log(1)");

    expect((await serve("/dashboard/favicon.svg"))!.headers.get("content-type")).toBe("image/svg+xml");
    expect((await serve("/dashboard/data.bin"))!.headers.get("content-type")).toBe("application/octet-stream");
  });

  it("answers HEAD without a body and ignores other methods", async () => {
    const head = (await serve("/dashboard/", "HEAD"))!;
    expect(head.status).toBe(200);
    expect(head.headers.get("content-length")).toBe("13");
    expect(await head.text()).toBe("");
    expect(await serve("/dashboard/", "POST")).toBeUndefined();
  });

  it("returns undefined for missing files and paths outside the base", async () => {
    expect(await serve("/dashboard/nope.js")).toBeUndefined();
    expect(await serve("/dashboard/nope/")).toBeUndefined();
    expect(await serve("/dashboardx/index.html")).toBeUndefined();
    expect(await serve("/index.html")).toBeUndefined();
    expect(await serve("/dashboard/%E0%A4%A")).toBeUndefined();
  });

  it("never reads outside the root", async () => {
    for (const path of [
      "/dashboard/../package.json",
      "/dashboard/%2e%2e/package.json",
      "/dashboard/..%2fpackage.json",
      "/dashboard/..%2Fpackage.json",
      "/dashboard/%2e%2e%2fpackage.json",
      "/dashboard/council/..%2f..%2fpackage.json",
      "/dashboard/..%5cpackage.json",
      "/dashboard/%252e%252e/package.json",
      "/dashboard/index.html%00",
    ]) {
      const res = await serve(path);
      expect(res, path).toBeUndefined();
    }
  });
});

describe("toRequest / sendResponse", () => {
  let server: Server;
  let origin: string;

  beforeAll(async () => {
    server = createServer(async (req, res) => {
      const request = toRequest(req, `http://${req.headers.host}`);
      const echo = {
        method: request.method,
        url: request.url,
        contentType: request.headers.get("content-type"),
        cookie: request.headers.get("cookie"),
        body: request.method === "GET" ? null : await request.text(),
      };
      const headers = new Headers({ "content-type": "application/json", "x-test": "yes" });
      headers.append("set-cookie", "a=1; Path=/");
      headers.append("set-cookie", "b=2; Path=/");
      await sendResponse(res, new Response(request.url.endsWith("/empty") ? null : JSON.stringify(echo), { status: request.url.endsWith("/empty") ? 204 : 201, headers }));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

  it("round-trips method, URL, headers, body and multiple cookies", async () => {
    const res = await fetch(`${origin}/dashboard/api/actions/remember?x=1`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: "hippo_local=abc" },
      body: JSON.stringify({ text: "Lease draft received." }),
    });
    expect(res.status).toBe(201);
    expect(res.headers.get("x-test")).toBe("yes");
    expect(res.headers.getSetCookie()).toEqual(["a=1; Path=/", "b=2; Path=/"]);
    expect(await res.json()).toEqual({
      method: "POST",
      url: `${origin}/dashboard/api/actions/remember?x=1`,
      contentType: "application/json",
      cookie: "hippo_local=abc",
      body: '{"text":"Lease draft received."}',
    });
  });

  it("handles GET and empty responses", async () => {
    const get = await fetch(`${origin}/dashboard/api/overview`);
    expect(await get.json()).toMatchObject({ method: "GET", body: null });
    const empty = await fetch(`${origin}/empty`);
    expect(empty.status).toBe(204);
    expect(await empty.text()).toBe("");
  });
});
