import { describe, expect, it } from "vitest";
import { hostedDemo } from "./demo-hosted.ts";
import type { HostedSetupStatus } from "./setup.ts";
import type { DashboardSource } from "./source.ts";

const ORIGIN = "http://127.0.0.1:4339";
const source = { info: async () => ({ mode: "demo", vault: { kind: "memory" }, campaign: "lisbon-arc", human: "player", actor: { kind: "human", id: "player" } }) } as unknown as DashboardSource;

function client() {
  const demo = hostedDemo({ base: "/dashboard", source, approveAfter: 0, initDelay: 0 });
  const call = async (path: string, body?: unknown) => {
    const res = await demo(new Request(`${ORIGIN}${path}`, body === undefined ? {} : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }));
    return { status: res?.status, body: res && res.headers.get("content-type")?.includes("json") ? await res.json() : undefined, location: res?.headers.get("location") };
  };
  return { demo, call, api: (path: string, body?: unknown) => call(`/dashboard/api/${path}`, body) };
}

describe("hosted demo", () => {
  it("walks from signed out to a vault with keys", async () => {
    const { call, api } = client();
    expect((await call("/dashboard/")).location).toBe("/dashboard/welcome/");
    expect((await api("session")).status).toBe(401);
    expect((await call("/dashboard/auth/login?return=%2Fdashboard%2Fsetup%2F")).location).toBe("/dashboard/setup/");
    expect((await api("session")).body).toMatchObject({ mode: "setup", user: { login: "player" }, account: { status: "waitlisted" }, capabilities: { setup: "hosted" } });
    expect((await api("setup/repos")).status).toBe(403);

    await api("setup/access", { note: "Moving to Lisbon." });
    await new Promise((r) => setTimeout(r, 5));
    expect(((await api("setup/status")).body as HostedSetupStatus).account.status).toBe("approved");

    expect((await api("__demo/install")).location).toBe("/dashboard/setup/#repo");
    const repos = (await api("setup/repos")).body as { repos: { id: number; fullName: string; private: boolean }[] };
    const empty = repos.repos.find((r) => r.fullName === "player/vault")!;
    const pub = repos.repos.find((r) => !r.private)!;
    expect((await api("setup/init", { repoId: pub.id, campaign: "Lisbon Arc" })).body).toMatchObject({ code: "PUBLIC_REPO" });
    expect((await api("setup/init", { repoId: empty.id, campaign: "Lisbon Arc" })).body).toMatchObject({ mode: "initialized", vault: { status: "ready" } });

    expect((await api("session")).body).toMatchObject({ mode: "worker", vault: { repo: "player/vault" }, capabilities: { setup: "hosted", curator: true } });
    const key = (await api("setup/keys", { kind: "curator" })).body as { token: string; scopes: string[]; snippets: unknown[] };
    expect(key.scopes).toEqual(["read", "curate"]);
    expect(key.token).toMatch(/^hippo_demo_/);
    expect(((await api("setup/keys")).body as { keys: { token?: string }[] }).keys.every((k) => k.token === undefined)).toBe(true);

    const curator = (await api("curator")).body as { run?: { id: string } };
    expect((await api("actions/curator", { abort: curator.run!.id })).body).toMatchObject({ history: expect.arrayContaining([expect.objectContaining({ id: curator.run!.id, outcome: "aborted" })]) });
  });

  it("deletes the account only with the typed login, and signs out", async () => {
    const { api } = client();
    await api("__demo/stage?to=ready");
    expect((await api("account/delete", { confirm: "someone" })).body).toMatchObject({ code: "CONFIRM" });
    expect((await api("account/delete", { confirm: "@player" })).body).toEqual({ ok: true });
    expect((await api("session")).status).toBe(401);
  });

  it("leaves everything else to the regular demo API", async () => {
    const { demo, api } = client();
    await api("__demo/stage?to=ready");
    expect(await demo(new Request(`${ORIGIN}/dashboard/api/overview`))).toBeUndefined();
    expect(await demo(new Request(`${ORIGIN}/dashboard/quests/`))).toBeUndefined();
  });
});
