import { describe, expect, it } from "vitest";
import { hostedDemo } from "./demo-hosted.ts";
import { VAULT_HEADER, type AdminReferrals, type HostedInvites, type HostedMembers, type HostedNewInvite, type HostedSetupStatus, type HostedVaults } from "./setup.ts";
import type { DashboardSource } from "./source.ts";

const ORIGIN = "http://127.0.0.1:4339";
const source = { info: async () => ({ mode: "demo", vault: { kind: "memory" }, campaign: "lisbon-arc", human: "player", actor: { kind: "human", id: "player" } }) } as unknown as DashboardSource;

function client(extra: { bootstrapFor?: number } = {}) {
  const demo = hostedDemo({ base: "/dashboard", source, approveAfter: 0, initDelay: 0, firstCallAfter: 0, ...extra });
  const call = async (path: string, body?: unknown, headers: Record<string, string> = {}) => {
    const res = await demo(new Request(`${ORIGIN}${path}`, body === undefined ? { headers } : { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) }));
    return { status: res?.status, body: res && res.headers.get("content-type")?.includes("json") ? await res.json() : undefined, location: res?.headers.get("location") };
  };
  return { demo, call, api: (path: string, body?: unknown, headers?: Record<string, string>) => call(`/dashboard/api/${path}`, body, headers) };
}

describe("hosted demo", () => {
  it("shares: members and invites on the first vault, a vault waiting to be accepted, and referrals", async () => {
    const { api } = client();
    await api("__demo/stage?to=ready");
    const members = (await api("vaults/members")).body as HostedMembers;
    expect(members.members.map((m) => [m.login, m.role])).toEqual([
      ["player", "owner"],
      ["game-master", "member"],
    ]);
    const made = (await api("vaults/members/invite", { role: "viewer", human: "flatmate", login: "flatmate-gh" })).body as HostedNewInvite;
    expect(made.link).toMatch(/\/dashboard\/invite\/#hinv_/);
    expect(((await api("vaults/members")).body as HostedMembers).invites?.map((i) => i.human)).toEqual(["flatmate"]);
    expect((await api("invites/peek", { token: made.link.split("#")[1] })).body).toMatchObject({ from: "player", vault: { fullName: "player/vault" } });

    const invites = (await api("invites")).body as HostedInvites;
    expect(invites.incoming.map((i) => i.vault?.fullName)).toEqual(["harbor-student/study-group"]);
    const accepted = (await api("invites/accept", { id: invites.incoming[0]!.id })).body as { vault: { id: string; role: string } };
    expect(accepted.vault.role).toBe("viewer");
    const on = { [VAULT_HEADER]: accepted.vault.id };
    expect((await api("session", undefined, on)).body).toMatchObject({ capabilities: { remember: false, curator: false } });
    expect((await api("actions/remember", { text: "x" }, on)).body).toMatchObject({ code: "READ_ONLY" });
    expect((await api("vaults/leave", {}, on)).body).toEqual({ ok: true });
    expect(((await api("vaults")).body as HostedVaults).vaults).toHaveLength(2);

    const graph = (await api("admin/referrals")).body as AdminReferrals;
    expect(graph.edges.length).toBeGreaterThan(2);
  });

  it("has two vaults when ready: switches between them, adds one, and removes one", async () => {
    const { api } = client();
    await api("__demo/stage?to=ready");
    const listed = (await api("vaults")).body as HostedVaults;
    expect(listed.vaults.map((v) => [v.fullName, v.provider])).toEqual([
      ["player/vault", "github"],
      ["player/lisbon-vault", "gitlab"],
    ]);
    expect(listed.current).toBe(listed.vaults[0]!.id);
    const [github, gitlab] = listed.vaults;
    const on = (id: string) => ({ [VAULT_HEADER]: id });
    expect((await api("session", undefined, on(gitlab!.id))).body).toMatchObject({ vault: { kind: "gitlab", repo: "player/lisbon-vault" } });
    // Remembered: without the header, the vault used last.
    expect((await api("vaults")).body).toMatchObject({ current: gitlab!.id });
    const status = (await api("setup/status", undefined, on(github!.id))).body as HostedSetupStatus;
    expect(status.mcpUrl).toBe(`${ORIGIN}/mcp/${github!.id}`);
    const key = (await api("setup/keys", { kind: "agent" }, on(github!.id))).body as { snippets: { code: string }[] };
    expect(key.snippets[0]!.code).toContain(`hippo-vault ${ORIGIN}/mcp/${github!.id}`);
    expect(((await api("setup/keys", undefined, on(gitlab!.id))).body as { keys: unknown[] }).keys).toEqual([]);
    expect((await api("overview", undefined, on("01J9Z8D3M0V999999999999999"))).status).toBe(404);

    // Adding: the repo picker sees an installation even beside ready vaults.
    await api("__demo/install");
    expect((await api("setup/init", { repoId: 501, name: "Again" })).body).toMatchObject({ code: "ALREADY_VAULT" });
    const added = (await api("setup/init", { repoId: 502, name: "Lisbon Arc" })).body as { vault: { id: string; fullName: string } };
    expect(added.vault.fullName).toBe("player/lisbon-arc");
    expect(((await api("vaults")).body as HostedVaults).vaults).toHaveLength(3);

    expect((await api("setup/vaults/remove", { id: added.vault.id, confirm: "player/vault" })).body).toMatchObject({ code: "CONFIRM" });
    expect((await api("setup/vaults/remove", { id: added.vault.id, confirm: "player/lisbon-arc" })).body).toEqual({ ok: true });
    expect(((await api("vaults")).body as HostedVaults).vaults.map((v) => v.id)).toEqual([github!.id, gitlab!.id]);
  });

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

  it("walks the GitLab path: connect, pick a project, a vault with no Actions curator", async () => {
    const { call, api } = client();
    await call("/dashboard/auth/login");
    await api("setup/access", { note: "Moving to Lisbon." });
    await new Promise((r) => setTimeout(r, 5));
    const before = (await api("setup/status")).body as HostedSetupStatus;
    expect(before.providers).toEqual(["github", "gitlab"]);
    expect(before.gitlab).toMatchObject({ connected: false, connectUrl: "/dashboard/api/__demo/gitlab-connect" });
    expect((await api("setup/repos?provider=gitlab")).body).toMatchObject({ code: "NO_GITLAB_CONNECTION" });

    expect((await api("__demo/gitlab-connect")).location).toBe("/dashboard/setup/#repo");
    const after = (await api("setup/status")).body as HostedSetupStatus;
    expect(after.gitlab).toMatchObject({ connected: true, login: "player" });
    expect(after.items.find((i) => i.id === "install")).toMatchObject({ title: "Connect GitLab", state: "done" });
    const { repos } = (await api("setup/repos?provider=gitlab")).body as { repos: { id: number; fullName: string; private: boolean }[] };
    const open = repos.find((r) => !r.private)!;
    const empty = repos.find((r) => r.fullName === "player/lisbon-vault")!;
    expect((await api("setup/init", { provider: "gitlab", repoId: open.id, campaign: "Lisbon Arc" })).body).toMatchObject({ code: "PUBLIC_REPO" });
    expect((await api("setup/init", { provider: "gitlab", repoId: empty.id, campaign: "Lisbon Arc" })).body).toMatchObject({ mode: "initialized", vault: { provider: "gitlab", url: "https://gitlab.example/player/lisbon-vault", status: "ready" } });

    expect((await api("session")).body).toMatchObject({ vault: { kind: "gitlab", repo: "player/lisbon-vault", url: "https://gitlab.example/player/lisbon-vault" } });
    expect((await api("setup/curator-actions", { enable: true })).body).toMatchObject({ code: "GITHUB_ONLY" });
    expect((await api("setup/gitlab/disconnect", {})).body).toMatchObject({ code: "HAS_VAULT" });
  });

  it("jumps to GitLab stages", async () => {
    const { api } = client();
    await api("__demo/stage?to=installed&provider=gitlab");
    expect(((await api("setup/status")).body as HostedSetupStatus).gitlab?.connected).toBe(true);
    await api("__demo/stage?to=ready&provider=gitlab");
    expect(((await api("setup/status")).body as HostedSetupStatus).vault).toMatchObject({ provider: "gitlab" });
  });

  it("clears the browser's setup drafts on a stage jump, then goes on", async () => {
    const { demo } = client();
    const res = (await demo(new Request(`${ORIGIN}/dashboard/api/__demo/stage?to=fresh`)))!;
    expect(res.status).toBe(200);
    expect(res.headers.get("x-demo-next")).toBe("/dashboard/setup/");
    const html = await res.text();
    expect(html).toContain("hippo:hosted-draft:");
    expect(html).toContain("hippo:adding-vault");
    expect(html).toContain('location.replace("/dashboard/setup/")');
    // Only that one script runs: it's allowed by its hash.
    expect(res.headers.get("content-security-policy")).toMatch(/script-src 'sha256-[A-Za-z0-9+/=]+'/);
    expect((await demo(new Request(`${ORIGIN}/dashboard/api/__demo/stage?to=nowhere`)))!.status).toBe(400);
  });

  it("has a stage for every onboarding state: denied, fresh, disconnected, bootstrapping", async () => {
    const { api } = client({ bootstrapFor: 5 });
    await api("__demo/stage?to=denied");
    expect(((await api("setup/status")).body as HostedSetupStatus).account.status).toBe("denied");

    await api("__demo/stage?to=fresh");
    const fresh = (await api("setup/status")).body as HostedSetupStatus;
    expect(fresh.account.status).toBe("approved");
    expect(fresh.installation).toBeUndefined();
    expect(fresh.vaults).toEqual([]);

    // A vault of your own, cut off, with the app installed again: its repo is offered to reconnect.
    await api("__demo/stage?to=disconnected");
    const gone = (await api("setup/status")).body as HostedSetupStatus;
    expect(gone.vault).toMatchObject({ fullName: "player/lisbon-arc", status: "disconnected" });
    const { repos } = (await api("setup/repos")).body as { repos: { fullName: string; adoptable?: boolean }[] };
    expect(repos.find((r) => r.fullName === "player/lisbon-arc")).toMatchObject({ adoptable: true });
    const back = (await api("setup/init", { repoId: 502, adopt: true })).body as { vault: { id: string; status: string }; mode: string };
    expect(back).toMatchObject({ mode: "adopted", vault: { id: gone.vault!.id, status: "ready" } });

    await api("__demo/stage?to=disconnected&provider=gitlab");
    const lab = (await api("setup/status")).body as HostedSetupStatus;
    expect(lab.vault).toMatchObject({ provider: "gitlab", status: "disconnected" });
    expect((await api("setup/init", { provider: "gitlab", repoId: 704, adopt: true })).body).toMatchObject({ mode: "adopted", vault: { id: lab.vault!.id, status: "ready" } });

    await api("__demo/stage?to=bootstrapping");
    expect(((await api("setup/status")).body as HostedSetupStatus).vault?.status).toBe("bootstrapping");
    await new Promise((r) => setTimeout(r, 20));
    expect(((await api("setup/status")).body as HostedSetupStatus).vault?.status).toBe("ready");
  });

  it("offers an existing vault among the GitLab projects, checked by the repo list", async () => {
    const { api } = client();
    await api("__demo/stage?to=installed&provider=gitlab");
    const { repos } = (await api("setup/repos?provider=gitlab")).body as { repos: { id: number; adoptable?: boolean }[] };
    expect(repos.find((r) => r.id === 704)).toMatchObject({ adoptable: true });
  });

  it("plays device sign-in: an agent asks, the person approves on the connect page, and it calls in", async () => {
    const { call, api } = client();
    await api("__demo/stage?to=ready");
    const started = await api("__demo/device");
    const code = new URL(started.location!, ORIGIN).searchParams.get("code")!;
    expect(started.location).toBe(`/dashboard/connect/?code=${code}`);
    expect(code).toMatch(/^[BCDFGHJKLMNPQRSTVWXZ]{4}-[BCDFGHJKLMNPQRSTVWXZ]{4}$/);
    const asked = (await api(`connect?code=${code}`)).body as { client: string; access: string; vaults: { id: string }[]; current?: string };
    expect(asked).toMatchObject({ client: "Claude Code", access: "remember" });
    expect(asked.vaults).toHaveLength(2);
    expect((await api("connect/approve", { code, vault: asked.vaults[0]!.id })).body).toEqual({ ok: true });
    // Once answered, the code is spent.
    expect((await api(`connect?code=${code}`)).status).toBe(410);
    await new Promise((r) => setTimeout(r, 5));
    const keys = (await api("setup/keys", undefined, { [VAULT_HEADER]: asked.vaults[0]!.id })).body as { keys: { kind: string; label: string; lastUsed?: string }[]; agents?: { agent: string }[] };
    expect(keys.keys).toEqual([expect.objectContaining({ kind: "agent", label: "Claude Code", lastUsed: expect.any(String) })]);
    expect(keys.agents?.map((a) => a.agent)).toEqual(["claude-code-home-finder"]);

    // A curator asks for curate, and gets a curator key; a refusal makes nothing.
    const curator = new URL((await api("__demo/device?access=curate")).location!, ORIGIN).searchParams.get("code")!;
    await api("connect/approve", { code: curator, vault: asked.vaults[0]!.id });
    const refused = new URL((await api("__demo/device")).location!, ORIGIN).searchParams.get("code")!;
    expect((await api("connect/deny", { code: refused })).body).toEqual({ ok: true });
    const after = (await api("setup/keys", undefined, { [VAULT_HEADER]: asked.vaults[0]!.id })).body as { keys: { kind: string }[] };
    expect(after.keys.map((k) => k.kind)).toEqual(["agent", "curator"]);
    expect((await call("/dashboard/api/__demo/device")).location).toMatch(/^\/dashboard\/connect\/\?code=/);
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
