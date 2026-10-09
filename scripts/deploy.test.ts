import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "jsonc-parser";
import { describe, expect, it } from "vitest";
// @ts-expect-error plain ESM script without types
import { deployConfig, probeProblems } from "./deploy.mjs";

const HOST = "hippo.example.test";
const IDS = { registryId: "8c1f2b3a-4d5e-4f60-9a7b-1c2d3e4f5a6b", oauthKvId: "0f1e2d3c4b5a69788796a5b4c3d2e1f0" };
const wrangler = parse(readFileSync(join(import.meta.dirname, "../apps/worker/wrangler.jsonc"), "utf8"), [], { allowTrailingComma: true });

describe("deployConfig", () => {
  it("fills in this repo's wrangler.jsonc with the instance's ids, and serves only its custom domain", () => {
    const out = deployConfig(wrangler, { host: HOST, ...IDS });
    expect(out.d1_databases).toEqual([{ ...wrangler.d1_databases[0], database_id: IDS.registryId }]);
    expect(out.kv_namespaces).toEqual([{ binding: "OAUTH_KV", id: IDS.oauthKvId }]);
    expect(out).toMatchObject({ name: "hippocampus", routes: [{ pattern: HOST, custom_domain: true }], workers_dev: false, preview_urls: false });
    // Everything else as committed: the Durable Object, its migrations, the assets, the rate limits.
    for (const key of ["main", "durable_objects", "migrations", "assets", "ratelimits", "observability"]) expect(out[key], key).toEqual(wrangler[key]);
    expect(wrangler.d1_databases[0].database_id).toBe("00000000-0000-0000-0000-000000000000");
  });

  it("refuses a host with a scheme, path or wildcard, and ids that are missing or still placeholders", () => {
    for (const host of [undefined, "", "https://hippo.example.test", "hippo.example.test/", "*.example.test", "Hippo.Example.Test", "localhost"])
      expect(() => deployConfig(wrangler, { host, ...IDS }), String(host)).toThrow("HIPPO_HOST");
    for (const registryId of [undefined, "00000000-0000-0000-0000-000000000000", "hippocampus-registry"])
      expect(() => deployConfig(wrangler, { host: HOST, ...IDS, registryId }), String(registryId)).toThrow("CF_REGISTRY_DATABASE_ID");
    for (const oauthKvId of [undefined, "11111111111111111111111111111111", IDS.registryId]) expect(() => deployConfig(wrangler, { host: HOST, ...IDS, oauthKvId }), String(oauthKvId)).toThrow("CF_OAUTH_KV_ID");
  });

  it("finds the bindings by name", () => {
    expect(() => deployConfig({ ...wrangler, d1_databases: [] }, { host: HOST, ...IDS })).toThrow("no REGISTRY database");
    expect(() => deployConfig({ ...wrangler, kv_namespaces: [{ binding: "SESSIONS", id: "x" }] }, { host: HOST, ...IDS })).toThrow("no OAUTH_KV namespace");
  });
});

describe("probeProblems", () => {
  const healthy = {
    home: { status: 302, location: "/dashboard/welcome/" },
    welcome: { status: 200, type: "text/html; charset=utf-8" },
    resource: { status: 200, body: { resource: `https://${HOST}/mcp` } },
    mcp: { status: 401 },
  };

  it("passes a configured, migrated Worker on its own origin", () => {
    expect(probeProblems(HOST, healthy)).toEqual([]);
  });

  it("names what a broken deploy looks like", () => {
    expect(probeProblems(HOST, { ...healthy, home: { status: 503, location: null } })).toEqual(["GET / is 503: the Worker is missing a binding or secret"]);
    expect(probeProblems(HOST, { ...healthy, welcome: { status: 404, type: "text/plain" } })[0]).toContain("dashboard assets");
    expect(probeProblems(HOST, { ...healthy, resource: { status: 404 } })[0]).toContain("HIPPO_PUBLIC_URL");
    expect(probeProblems(HOST, { ...healthy, resource: { status: 200, body: { resource: "https://hippocampus.example.workers.dev/mcp" } } })[0]).toContain("HIPPO_PUBLIC_URL");
    expect(probeProblems(HOST, { ...healthy, mcp: { status: 500 } })).toEqual(["MCP with an unknown key is 500: the registry (D1) isn't reachable or migrated"]);
    expect(probeProblems(HOST, { ...healthy, mcp: { status: 200 } })).toEqual(["MCP with an unknown key is 200, not 401"]);
  });
});
