import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { FakeGitHub, signWebhook } from "./fake-github.ts";

const API = "https://api.github.com";
const b64 = (s: string) => Buffer.from(s).toString("base64");

/** A request to the fake, as `[status, json]`. */
function client(gh: FakeGitHub) {
  return async (method: string, path: string, opts: { token?: string; body?: unknown } = {}): Promise<[number, any]> => {
    const res = await gh.fetch(`${API}${path}`, {
      method,
      headers: opts.token ? { authorization: `Bearer ${opts.token}` } : {},
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    });
    const text = await res.text();
    return [res.status, text ? JSON.parse(text) : undefined];
  };
}

async function campaign() {
  const gh = await FakeGitHub.create({ "README.md": "# Vault\n" });
  const notes = await gh.addRepo({ fullName: "player/notes", files: { "a.md": "a" } });
  const fresh = await gh.addRepo({ fullName: "harbor-university/vault", empty: true, private: false });
  const mine = gh.addInstallation({ account: { id: 1, login: "player", type: "User" }, repos: [gh.repo, notes.fullName] });
  const org = gh.addInstallation({ account: { id: 2, login: "harbor-university", type: "Organization" }, repos: [fresh.fullName], permissions: { metadata: "read", contents: "read" } });
  return { gh, notes, fresh, mine, org, api: client(gh) };
}

describe("FakeGitHub repos", () => {
  it("serves several repos, including empty ones", async () => {
    const { gh, fresh, api } = await campaign();
    expect(await api("GET", "/repos/harbor-university/vault")).toEqual([
      200,
      { id: fresh.id, name: "vault", full_name: "harbor-university/vault", owner: { login: "harbor-university" }, private: false, default_branch: "main", size: 0 },
    ]);
    expect((await api("GET", "/repos/player/vault"))[1]).toMatchObject({ id: gh.at(gh.repo).id, private: true, size: 1 });
    expect(await api("GET", "/repos/harbor-university/vault/git/ref/heads/main")).toEqual([409, { message: "Git Repository is empty." }]);
    expect((await api("POST", "/repos/harbor-university/vault/git/trees", { body: { tree: [] } }))[0]).toBe(409);
    expect((await api("GET", "/repos/player/nope"))[0]).toBe(404);
    expect(fresh.calls).toEqual(["GET ", "GET git/ref/heads/main", "POST git/trees"]);
  });

  it("makes an empty repo's first commit through the Contents API, on the branch named", async () => {
    const { fresh, api } = await campaign();
    const [status, out] = await api("PUT", "/repos/harbor-university/vault/contents/README.md", { body: { message: "first", content: b64("# Harbor\n"), branch: "trunk" } });
    expect(status).toBe(201);
    expect(out.content.path).toBe("README.md");
    expect(fresh.empty).toBe(false);
    expect(fresh.defaultBranch).toBe("trunk");
    expect(fresh.files()).toEqual({ "README.md": "# Harbor\n" });
    expect(fresh.log().map((c) => c.message)).toEqual(["first"]);
  });

  it("updates a file only against its current sha", async () => {
    const { gh, api } = await campaign();
    const path = "/repos/player/vault/contents/README.md";
    expect(await api("PUT", path, { body: { message: "x", content: b64("new") } })).toEqual([422, { message: 'Invalid request.\n\n"sha" wasn\'t supplied.' }]);
    expect((await api("PUT", path, { body: { message: "x", content: b64("new"), sha: "0".repeat(40) } }))[0]).toBe(409);
    const sha = gh.at(gh.repo).tree().get("README.md")!.sha;
    expect((await api("PUT", path, { body: { message: "edit", content: b64("# Vault (renamed)\n"), sha } }))[0]).toBe(200);
    expect((await api("PUT", "/repos/player/vault/contents/notes/lisbon.md", { body: { message: "add", content: b64("Lisboa") } }))[0]).toBe(201);
    expect(gh.files()).toEqual({ "README.md": "# Vault (renamed)\n", "notes/lisbon.md": "Lisboa" });
    expect((await api("PUT", path, { body: { message: "x", content: b64("x"), branch: "nope" } }))[0]).toBe(404);
  });

  it("creates branches", async () => {
    const { gh, api } = await campaign();
    const head = gh.refs.get("main")!;
    expect((await api("POST", "/repos/player/vault/git/refs", { body: { ref: "refs/heads/sleep", sha: head } }))[0]).toBe(201);
    expect(gh.files("sleep")).toEqual(gh.files());
    expect(await api("POST", "/repos/player/vault/git/refs", { body: { ref: "refs/heads/sleep", sha: head } })).toEqual([422, { message: "Reference already exists" }]);
    expect((await api("POST", "/repos/player/vault/git/refs", { body: { ref: "refs/heads/other", sha: "f".repeat(40) } }))[0]).toBe(422);
  });
});

describe("FakeGitHub auth and apps", () => {
  it("checks tokens only when asked to", async () => {
    const { gh, api } = await campaign();
    expect((await api("GET", "/repos/player/vault/git/ref/heads/main"))[0]).toBe(200);
    gh.requireAuth = true;
    expect(await api("GET", "/repos/player/vault/git/ref/heads/main")).toEqual([401, { message: "Bad credentials" }]);
    expect((await api("GET", "/repos/player/vault/git/ref/heads/main", { token: "made-up" }))[0]).toBe(401);
  });

  it("mints installation tokens for the installation's repos, narrowed on request", async () => {
    const { gh, notes, mine, api } = await campaign();
    gh.requireAuth = true;
    const [status, all] = await api("POST", `/app/installations/${mine.id}/access_tokens`, { token: "app.jwt" });
    expect(status).toBe(201);
    expect(all).toMatchObject({ token: expect.stringMatching(/^ghs_/), permissions: mine.permissions });
    expect((await api("GET", "/installation/repositories", { token: all.token }))[1].repositories.map((r: { full_name: string }) => r.full_name)).toEqual(["player/vault", "player/notes"]);

    const [, one] = await api("POST", `/app/installations/${mine.id}/access_tokens`, { token: "app.jwt", body: { repository_ids: [notes.id], permissions: { contents: "read" } } });
    expect(one.repositories.map((r: { full_name: string }) => r.full_name)).toEqual(["player/notes"]);
    expect(await api("GET", "/installation/repositories", { token: one.token })).toMatchObject([200, { total_count: 1 }]);
    expect((await api("GET", "/repos/player/notes/git/ref/heads/main", { token: one.token }))[0]).toBe(200);
    expect((await api("GET", "/repos/player/vault/git/ref/heads/main", { token: one.token }))[0]).toBe(404);
    expect(await api("POST", "/repos/player/notes/git/trees", { token: one.token, body: { tree: [] } })).toEqual([403, { message: "Resource not accessible by integration" }]);

    const [, byName] = await api("POST", `/app/installations/${mine.id}/access_tokens`, { token: "app.jwt", body: { repositories: ["vault"] } });
    expect(byName.repositories.map((r: { full_name: string }) => r.full_name)).toEqual(["player/vault"]);
  });

  it("refuses to widen an installation", async () => {
    const { gh, fresh, mine, org, api } = await campaign();
    expect((await api("POST", `/app/installations/${mine.id}/access_tokens`, { token: "app.jwt", body: { repository_ids: [fresh.id] } }))[0]).toBe(422);
    expect((await api("POST", `/app/installations/${org.id}/access_tokens`, { token: "app.jwt", body: { permissions: { contents: "write" } } }))[0]).toBe(422);
    expect((await api("POST", "/app/installations/999999/access_tokens", { token: "app.jwt" }))[0]).toBe(404);
    expect((await api("POST", `/app/installations/${mine.id}/access_tokens`))[0]).toBe(401);
    gh.verifyAppJwt = (jwt) => jwt === "signed.by.app";
    expect((await api("POST", `/app/installations/${mine.id}/access_tokens`, { token: "app.jwt" }))[0]).toBe(401);
    expect((await api("POST", `/app/installations/${mine.id}/access_tokens`, { token: "signed.by.app" }))[0]).toBe(201);
  });

  it("needs the workflows permission to write workflow files", async () => {
    const { gh, mine, api } = await campaign();
    gh.requireAuth = true;
    const [, t] = await api("POST", `/app/installations/${mine.id}/access_tokens`, { token: "app.jwt", body: { permissions: { contents: "write" } } });
    const put = (token: string) => api("PUT", "/repos/player/vault/contents/.github/workflows/vault.yml", { token, body: { message: "ci", content: b64("on: push\n") } });
    expect((await put(t.token))[0]).toBe(403);
    const [, w] = await api("POST", `/app/installations/${mine.id}/access_tokens`, { token: "app.jwt", body: { permissions: { contents: "write", workflows: "write" } } });
    expect((await put(w.token))[0]).toBe(201);
  });

  it("expires tokens after an hour and revokes them on uninstall", async () => {
    const { gh, mine, api } = await campaign();
    gh.requireAuth = true;
    let clock = new Date("2026-10-09T12:00:00Z");
    gh.now = () => clock;
    const [, minted] = await api("POST", `/app/installations/${mine.id}/access_tokens`, { token: "app.jwt" });
    expect(minted.expires_at).toBe("2026-10-09T13:00:00.000Z");
    clock = new Date("2026-10-09T13:00:01Z");
    expect((await api("GET", "/repos/player/vault", { token: minted.token }))[0]).toBe(401);
    clock = new Date("2026-10-09T12:30:00Z");
    expect((await api("GET", "/repos/player/vault", { token: minted.token }))[0]).toBe(200);
    expect((await api("DELETE", `/app/installations/${mine.id}`, { token: "app.jwt" }))[0]).toBe(204);
    expect((await api("GET", "/repos/player/vault", { token: minted.token }))[0]).toBe(401);
    expect((await api("DELETE", `/app/installations/${mine.id}`, { token: "app.jwt" }))[0]).toBe(404);
  });

  it("shows a signed-in user their installations and those of their organizations", async () => {
    const { gh, mine, org, api } = await campaign();
    gh.addUser({ login: "player", id: 1, token: "gho_player", installations: [org.id] });
    gh.addUser({ login: "archivist", token: "gho_archivist" });
    expect(await api("GET", "/user", { token: "gho_player" })).toEqual([200, { login: "player", id: 1, type: "User" }]);
    expect((await api("GET", "/user"))[0]).toBe(401);
    const [, list] = await api("GET", "/user/installations", { token: "gho_player" });
    expect(list.installations.map((i: { id: number; account: { login: string } }) => [i.id, i.account.login])).toEqual([
      [mine.id, "player"],
      [org.id, "harbor-university"],
    ]);
    const [, repos] = await api("GET", `/user/installations/${mine.id}/repositories`, { token: "gho_player" });
    expect(repos.repositories.map((r: { full_name: string }) => r.full_name)).toEqual(["player/vault", "player/notes"]);
    expect(await api("GET", "/user/installations", { token: "gho_archivist" })).toEqual([200, { total_count: 0, installations: [] }]);
    expect((await api("GET", `/user/installations/${mine.id}/repositories`, { token: "gho_archivist" }))[0]).toBe(404);
  });

  it("signs webhooks the way GitHub does", async () => {
    const body = JSON.stringify({ action: "created", installation: { id: 1 } });
    expect(await signWebhook("webhook-secret", body)).toBe(`sha256=${createHmac("sha256", "webhook-secret").update(body).digest("hex")}`);
  });
});
