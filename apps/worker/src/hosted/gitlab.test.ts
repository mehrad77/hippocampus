import { buildVaultFiles } from "@hippocampus/core";
import type { HostedSetupStatus } from "@hippocampus/dashboard";
import { TEMPLATE } from "@hippocampus/template";
import { describe, expect, it } from "vitest";
import { GM, PLAYER, SETTINGS, hostedApp, type HostedHarness, type Visit } from "../testing/hosted-app.ts";
import { ORIGIN, GITLAB } from "./testing.ts";
import { GitLabAuthError } from "./gitlab.ts";
import { gitlabSettings } from "./settings.ts";
import { open, seal } from "./token-box.ts";

const HOUR = 3600_000;

/** A hosted app with GitLab on, an approved `player` signed in, and a clock the test can move. */
async function setup() {
  let at = Date.parse("2026-10-11T10:00:00.000Z");
  const h = await hostedApp({ gitlab: true, now: () => new Date(at) });
  const gl = h.gl!;
  const visit = h.browser();
  await h.signIn(visit, "player");
  await h.registry.setAccountStatus(PLAYER.id, "approved");
  await gl.addProject({ fullName: "player/vault", id: 555, empty: true });
  return { h, gl, visit, tick: (ms: number) => void (at += ms) };
}

const status = async (h: HostedHarness, visit: Visit) => (await (await h.api(visit, "setup/status")).json()) as HostedSetupStatus;
const init = (h: HostedHarness, visit: Visit, body: Record<string, unknown>) => h.post(visit, "setup/init", { provider: "gitlab", ...SETTINGS, ...body });

describe("GitLab is optional", () => {
  it("is not offered, and its routes are closed, when the instance has no GitLab set up", async () => {
    const h = await hostedApp();
    const visit = h.browser();
    await h.signIn(visit, "player");
    await h.registry.setAccountStatus(PLAYER.id, "approved");
    const s = await status(h, visit);
    expect(s.providers).toEqual(["github"]);
    expect(s.gitlab).toBeUndefined();
    expect((await visit(`${ORIGIN}/dashboard/setup/gitlab/connect`)).status).toBe(404);
    expect((await h.api(visit, "setup/repos?provider=gitlab")).status).toBe(404);
  });

  it("is all-or-nothing in the settings", () => {
    const key = GITLAB.tokenKey;
    expect(gitlabSettings({})).toBeUndefined();
    expect(() => gitlabSettings({ GITLAB_CLIENT_ID: "x" })).toThrow(/missing GITLAB_CLIENT_SECRET, HIPPO_TOKEN_KEY/);
    expect(() => gitlabSettings({ GITLAB_CLIENT_ID: "x", GITLAB_CLIENT_SECRET: "y", HIPPO_TOKEN_KEY: btoa("sixteen bytes!!!") })).toThrow(/32 bytes/);
    expect(() => gitlabSettings({ GITLAB_CLIENT_ID: "x", GITLAB_CLIENT_SECRET: "y", HIPPO_TOKEN_KEY: key, GITLAB_URL: "http://gitlab.example" })).toThrow(/https/);
    expect(gitlabSettings({ GITLAB_CLIENT_ID: "x", GITLAB_CLIENT_SECRET: "y", HIPPO_TOKEN_KEY: key, GITLAB_URL: "https://git.example.org/" })).toMatchObject({ url: "https://git.example.org", clientId: "x" });
  });
});

describe("sealed tokens", () => {
  it("open only for their owner and key", async () => {
    const sealed = await seal(GITLAB.tokenKey, "gitlab:1", { access: "a" });
    expect(await open(GITLAB.tokenKey, "gitlab:1", sealed)).toEqual({ access: "a" });
    expect(await open(GITLAB.tokenKey, "gitlab:2", sealed)).toBeUndefined();
    expect(await open(btoa(String.fromCharCode(...new Uint8Array(32).fill(9))), "gitlab:1", sealed)).toBeUndefined();
    expect(sealed).not.toContain("access");
  });
});

describe("connecting GitLab", () => {
  it("sends the person to GitLab with PKCE, then back to pick a project", async () => {
    const { h, visit } = await setup();
    const toGitLab = await visit(`${ORIGIN}/dashboard/setup/gitlab/connect`);
    expect(toGitLab.status).toBe(302);
    const authorize = new URL(toGitLab.headers.get("location")!);
    expect(authorize.origin + authorize.pathname).toBe("https://gitlab.test/oauth/authorize");
    expect(Object.fromEntries(authorize.searchParams)).toMatchObject({ client_id: "gl-client", response_type: "code", scope: "api", code_challenge_method: "S256", redirect_uri: `${ORIGIN}/oauth/gitlab/callback` });

    const back = await h.connectGitLab(visit, "player");
    expect(back.status).toBe(302);
    expect(back.headers.get("location")).toBe("/dashboard/setup/#repo");
    const s = await status(h, visit);
    expect(s.providers).toEqual(["github", "gitlab"]);
    expect(s.gitlab).toMatchObject({ connected: true, login: "player", repos: [{ id: 555, fullName: "player/vault", private: true, empty: true }] });
  });

  it("stores the tokens sealed, never in the clear", async () => {
    const { h, visit } = await setup();
    await h.connectGitLab(visit, "player");
    const row = await h.registry.gitlabCredential(PLAYER.id);
    expect(row).toMatchObject({ gitlabLogin: "player", version: 0 });
    expect(row!.secret).toMatch(/^v1\./);
    expect(row!.secret).not.toContain("gla-");
  });

  it("lists only private-fit projects the person can push to, in their own namespace", async () => {
    const { h, gl, visit } = await setup();
    await gl.addProject({ fullName: "player/notes", id: 556, visibility: "public", files: { "a.md": "a" } });
    await gl.addProject({ fullName: "harbor-university/campus", id: 557, namespace: { id: 9, kind: "group" }, members: { player: 50 } });
    await gl.addProject({ fullName: "game-master/vault", id: 558, members: { "game-master": 50, player: 20 } });
    await h.connectGitLab(visit, "player");
    const { repos } = (await (await h.api(visit, "setup/repos?provider=gitlab")).json()) as { repos: { id: number; private: boolean }[] };
    expect(repos.map((r) => r.id).sort()).toEqual([555, 556]);
    expect(repos.find((r) => r.id === 556)!.private).toBe(false);
  });

  it("refuses a callback that wasn't started here, or by someone else, or twice", async () => {
    const { h, gl, visit } = await setup();
    const toGitLab = await visit(`${ORIGIN}/dashboard/setup/gitlab/connect`);
    const callback = gl.approve(toGitLab.headers.get("location")!, "player");

    // Another signed-in account can't finish it.
    const other = h.browser();
    await h.signIn(other, "game-master");
    expect((await other(callback)).status).toBe(403);

    // The state is spent by that attempt.
    expect((await visit(callback)).status).toBe(400);
    expect(await h.registry.gitlabCredential(PLAYER.id)).toBeUndefined();
    expect(await h.registry.gitlabCredential(GM.id)).toBeUndefined();
  });

  it("needs a signed-in, approved account to start", async () => {
    const { h } = await setup();
    const anon = h.browser();
    expect((await anon(`${ORIGIN}/dashboard/setup/gitlab/connect`)).headers.get("location")).toContain("/dashboard/auth/login");
    const waiting = h.browser();
    await h.signIn(waiting, "job-scout");
    expect((await waiting(`${ORIGIN}/dashboard/setup/gitlab/connect`)).status).toBe(403);
  });
});

describe("a vault on GitLab", () => {
  async function ready() {
    const ctx = await setup();
    await ctx.h.connectGitLab(ctx.visit, "player");
    const res = await init(ctx.h, ctx.visit, { repoId: 555 });
    if (res.status !== 200) throw new Error(`init: ${res.status} ${await res.text()}`);
    return { ...ctx, result: (await res.json()) as { vault: { id: string; provider: string; fullName: string }; mode: string } };
  }

  it("is initialized from the template in one commit, without GitHub's workflow", async () => {
    const { gl, result } = await ready();
    expect(result).toMatchObject({ mode: "initialized", vault: { provider: "gitlab", fullName: "player/vault", url: "https://gitlab.test/player/vault" } });
    const files = gl.files("main", gl.projects.get(555)!);
    expect(files["_hippo/config.yaml"]).toBeDefined();
    expect(Object.keys(files).filter((p) => p.startsWith(".github/"))).toEqual([]);
    const log = gl.log("main", gl.projects.get(555)!);
    expect(log).toHaveLength(1);
    expect(log[0]!.message).toMatch(/^chore: initialize Hippocampus vault \[skip ci\]/);
    expect(log[0]!.message).toContain("Hippo-Actor: bootstrap");
  });

  it("registers the project id under its provider, and configures the vault's object for GitLab", async () => {
    const { h, result } = await ready();
    const vault = (await h.registry.vault(result.vault.id))!;
    expect(vault).toMatchObject({ provider: "gitlab", repoId: 555, installationId: 0, status: "ready" });
    // Stored negated, so a GitHub repo with the same number can't collide with it.
    expect((await h.registry.db.all<{ repo_id: number }>("SELECT repo_id FROM vaults"))[0]!.repo_id).toBe(-555);
    expect((await h.registry.vaultByRepo(555, "gitlab"))!.id).toBe(vault.id);
    expect(await h.registry.vaultByRepo(555)).toBeUndefined();
    const configure = h.vaults.to(vault.id, "configure").at(-1)!;
    expect(configure.meta).toMatchObject({ provider: "gitlab", accountId: PLAYER.id, repoId: 555, installationId: 0 });
  });

  it("serves mcp keys like any vault", async () => {
    const { h, result } = await ready();
    const token = await h.mintKey(result.vault.id, { kind: "agent" });
    const res = await h.callMcp(token);
    expect(res.status).toBe(200);
  });

  it("refuses a project that isn't private, naming internal too", async () => {
    const { h, gl, visit } = await setup();
    await h.connectGitLab(visit, "player");
    await gl.addProject({ fullName: "player/open", id: 600, visibility: "internal", empty: true });
    const res = await init(h, visit, { repoId: 600 });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { code: string; error: string };
    expect(body.code).toBe("PUBLIC_REPO");
    expect(body.error).toMatch(/not private.*Internal isn't enough/s);
    expect(await h.registry.vaultOf(PLAYER.id)).toBeUndefined();
  });

  it("refuses a project that isn't one of the person's own", async () => {
    const { h, gl, visit } = await setup();
    await gl.addProject({ fullName: "harbor-university/campus", id: 557, namespace: { id: 9, kind: "group" }, members: { player: 50 }, empty: true });
    await h.connectGitLab(visit, "player");
    const res = await init(h, visit, { repoId: 557 });
    expect(res.status).toBe(404);
  });

  it("needs a GitLab connection", async () => {
    const { h, visit } = await setup();
    const res = await init(h, visit, { repoId: 555 });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { code: string }).code).toBe("NO_GITLAB_CONNECTION");
  });

  it("adopts an existing vault, adding only the guardrail files it lacks", async () => {
    const { h, gl, visit } = await setup();
    const built = await buildVaultFiles(TEMPLATE, { ...SETTINGS, human: "player" });
    // A vault made elsewhere: no GitHub workflow, and AGENTS.md went missing.
    const withoutGithub = Object.fromEntries(Object.entries(built).filter(([p]) => !p.startsWith(".github/") && p !== "AGENTS.md"));
    const project = await gl.addProject({ fullName: "player/old", id: 601, files: withoutGithub });
    await h.connectGitLab(visit, "player");
    const res = await init(h, visit, { repoId: 601 });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { mode: string }).mode).toBe("adopted");
    const [added] = gl.log("main", project);
    expect(added!.message).toMatch(/^chore: add Hippocampus guardrail files/);
    expect(Object.keys(gl.files("main", project))).toContain("AGENTS.md");
    // Whatever was there is untouched, and the GitHub workflow isn't added to a GitLab project.
    expect(gl.files("main", project)["_hippo/config.yaml"]).toBe(withoutGithub["_hippo/config.yaml"]);
    expect(Object.keys(gl.files("main", project)).filter((p) => p.startsWith(".github/"))).toEqual([]);
  });

  it("refuses a project with other files in it", async () => {
    const { h, gl, visit } = await setup();
    await gl.addProject({ fullName: "player/busy", id: 602, files: { "src/app.ts": "x" } });
    await h.connectGitLab(visit, "player");
    const res = await init(h, visit, { repoId: 602 });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { code: string }).code).toBe("NOT_EMPTY");
  });

  it("has no GitHub Actions curator to toggle", async () => {
    const { h, visit } = await ready();
    const res = await h.post(visit, "setup/curator-actions", { enable: true });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { code: string }).code).toBe("GITHUB_ONLY");
    expect((await status(h, visit)).curatorActions).toBeUndefined();
  });
});

describe("the connection's tokens", () => {
  it("refresh before they expire, and the rotated refresh token is kept", async () => {
    const { h, gl, visit, tick } = await setup();
    await h.connectGitLab(visit, "player");
    const tokenFor = h.app.routes.gitlab!.tokenFor(PLAYER.id);
    const first = await tokenFor();
    expect(await tokenFor()).toBe(first);
    expect(gl.calls.filter((c) => c === "POST /oauth/token")).toHaveLength(0);

    tick(2 * HOUR - 60_000);
    const second = await tokenFor();
    expect(second).not.toBe(first);
    expect((await h.registry.gitlabCredential(PLAYER.id))!.version).toBe(1);
    // The old refresh token is spent at GitLab: a second refresh uses the rotated one.
    tick(2 * HOUR);
    expect(await tokenFor()).not.toBe(second);
    expect((await h.registry.gitlabCredential(PLAYER.id))!.version).toBe(2);
  });

  it("refresh once for several callers at the same moment", async () => {
    const { h, visit, tick } = await setup();
    await h.connectGitLab(visit, "player");
    const tokenFor = h.app.routes.gitlab!.tokenFor(PLAYER.id);
    tick(3 * HOUR);
    const tokens = await Promise.all([tokenFor(), tokenFor(), tokenFor()]);
    expect(new Set(tokens).size).toBe(1);
    expect((await h.registry.gitlabCredential(PLAYER.id))!.version).toBe(1);
  });

  it("lose a race gracefully: another isolate's refresh is used, not overwritten", async () => {
    const { h, gl, visit, tick } = await setup();
    await h.connectGitLab(visit, "player");
    const access = h.app.routes.gitlab!;
    tick(3 * HOUR);
    // Another isolate refreshes first (the registry's version moves on), then ours finds its refresh token spent.
    const row = (await h.registry.gitlabCredential(PLAYER.id))!;
    const tokens = (await open<{ refresh: string }>(GITLAB.tokenKey, `gitlab:${PLAYER.id}`, row.secret))!;
    const res = await gl.fetch("https://gitlab.test/oauth/token", {
      method: "POST",
      body: JSON.stringify({ client_id: "gl-client", client_secret: "gl-secret", grant_type: "refresh_token", refresh_token: tokens.refresh }),
    });
    const theirs = (await res.json()) as { access_token: string; refresh_token: string; expires_in: number };
    const sealed = await seal(GITLAB.tokenKey, `gitlab:${PLAYER.id}`, { access: theirs.access_token, refresh: theirs.refresh_token, expiresAt: Date.now() + 10 * HOUR });
    await h.registry.rotateGitLabSecret(PLAYER.id, row.version, sealed);
    // Ours read the old row before; simulate by asking while the stored token is already fresh.
    expect(await access.tokenFor(PLAYER.id)()).toBe(theirs.access_token);
  });

  it("report a revoked connection as one the person must redo", async () => {
    const { h, gl, visit, tick } = await setup();
    await h.connectGitLab(visit, "player");
    gl.revokeUser("player");
    tick(3 * HOUR);
    const err = await h.app.routes.gitlab!.tokenFor(PLAYER.id)().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GitLabAuthError);
    expect((err as GitLabAuthError).reason).toBe("revoked");
    const s = await status(h, visit);
    expect(s.gitlab).toMatchObject({ connected: false, error: expect.stringMatching(/connect it again/) });
  });

  it("are revoked at GitLab and forgotten when the account is deleted", async () => {
    const { h, gl, visit } = await setup();
    await h.connectGitLab(visit, "player");
    const res = await h.post(visit, "account/delete", { confirm: "player" });
    expect(res.status).toBe(200);
    expect(gl.revoked.length).toBe(2);
    expect(await h.registry.gitlabCredential(PLAYER.id)).toBeUndefined();
  });

  it("are dropped by disconnect, unless a vault depends on them", async () => {
    const { h, visit } = await setup();
    await h.connectGitLab(visit, "player");
    expect((await h.post(visit, "setup/gitlab/disconnect", {})).status).toBe(200);
    expect(await h.registry.gitlabCredential(PLAYER.id)).toBeUndefined();

    await h.connectGitLab(visit, "player");
    expect((await init(h, visit, { repoId: 555 })).status).toBe(200);
    const res = await h.post(visit, "setup/gitlab/disconnect", {});
    expect(res.status).toBe(409);
    expect(await h.registry.gitlabCredential(PLAYER.id)).toBeDefined();
  });
});

describe("the health check", () => {
  async function ready() {
    const ctx = await setup();
    await ctx.h.connectGitLab(ctx.visit, "player");
    const res = await init(ctx.h, ctx.visit, { repoId: 555 });
    const { vault } = (await res.json()) as { vault: { id: string } };
    return { ...ctx, id: vault.id };
  }

  it("leaves a healthy vault alone", async () => {
    const { h, id } = await ready();
    expect(await h.app.routes.checkGitLab()).toEqual([]);
    expect((await h.registry.vault(id))!.status).toBe("ready");
  });

  it("disconnects a vault whose project was made public (or internal), and reconnects it when private again", async () => {
    const { h, gl, id } = await ready();
    gl.projects.get(555)!.visibility = "internal";
    expect(await h.app.routes.checkGitLab()).toEqual([id]);
    expect(await h.registry.vault(id)).toMatchObject({ status: "disconnected", reason: "public" });
    expect(h.vaults.to(id, "disconnect").at(-1)!.reason).toBe("public");

    // Still public: nothing changes, nobody is told twice.
    expect(await h.app.routes.checkGitLab()).toEqual([]);

    gl.projects.get(555)!.visibility = "private";
    expect(await h.app.routes.checkGitLab()).toEqual([id]);
    expect((await h.registry.vault(id))!.status).toBe("ready");
    expect(h.vaults.to(id, "configure").length).toBeGreaterThan(1);
  });

  it("disconnects a vault whose project is gone", async () => {
    const { h, gl, id } = await ready();
    gl.projects.delete(555);
    expect(await h.app.routes.checkGitLab()).toEqual([id]);
    expect(await h.registry.vault(id)).toMatchObject({ status: "disconnected", reason: "repo_deleted" });
  });

  it("disconnects a vault whose connection was revoked, and reconnects after the person connects again", async () => {
    const { h, gl, visit, tick, id } = await ready();
    gl.revokeUser("player");
    tick(3 * HOUR);
    expect(await h.app.routes.checkGitLab()).toEqual([id]);
    expect(await h.registry.vault(id)).toMatchObject({ status: "disconnected", reason: "token_revoked" });

    await h.connectGitLab(visit, "player");
    expect(await h.app.routes.checkGitLab()).toEqual([id]);
    expect((await h.registry.vault(id))!.status).toBe("ready");
  });

  it("follows a rename", async () => {
    const { h, gl, id } = await ready();
    const p = gl.projects.get(555)!;
    Object.assign(p, { fullName: "player/memory" });
    expect(await h.app.routes.checkGitLab()).toEqual([id]);
    expect((await h.registry.vault(id))!.fullName).toBe("player/memory");
  });

  it("does nothing when GitLab itself is down", async () => {
    const { h, gl, id } = await ready();
    gl.strict = true;
    const down = gl.fetch;
    (gl as unknown as { fetch: typeof fetch }).fetch = async () => new Response("bad gateway", { status: 502 });
    expect(await h.app.routes.checkGitLab()).toEqual([]);
    (gl as unknown as { fetch: typeof fetch }).fetch = down;
    expect((await h.registry.vault(id))!.status).toBe("ready");
  });
});
