import { signWebhook } from "@hippocampus/store-github/testing";
import { beforeAll, describe, expect, it } from "vitest";
import { GitHubApp, appJwt, importAppKey, verifyWebhook } from "./github-app.ts";
import { APP, appKeyPair, checkAppJwt, hostedGitHub } from "./testing.ts";

let keys: Awaited<ReturnType<typeof appKeyPair>>;
beforeAll(async () => {
  keys = await appKeyPair();
});

const decode = (segment: string) => JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(segment.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0))));

describe("the app's JWT", () => {
  it("is RS256, signed with the app's key, backdated a minute and good for nine", async () => {
    const now = new Date("2026-10-01T09:00:00.000Z");
    const jwt = await appJwt({ appId: APP.id, privateKeyPem: keys.privateKeyPem, now });
    const [header, payload] = jwt.split(".");
    expect(decode(header!)).toEqual({ alg: "RS256", typ: "JWT" });
    const t = now.getTime() / 1000;
    expect(decode(payload!)).toEqual({ iat: t - 60, exp: t + 540, iss: APP.id });
    expect(await checkAppJwt(jwt, keys.publicKey, APP.id, now)).toBe(true);
    expect(await checkAppJwt(jwt, keys.publicKey, APP.id, new Date(now.getTime() + 10 * 60_000))).toBe(false);
    const other = await appKeyPair();
    expect(await checkAppJwt(jwt, other.publicKey, APP.id, now)).toBe(false);
  });

  it("reads a key pasted on one line with \\n escapes", async () => {
    await expect(importAppKey(keys.privateKeyPem.replace(/\n/g, "\\n"))).resolves.toBeDefined();
  });

  it("refuses PKCS#1 keys with the command that converts them", async () => {
    await expect(importAppKey("-----BEGIN RSA PRIVATE KEY-----\nMIIE\n-----END RSA PRIVATE KEY-----")).rejects.toThrow(/openssl pkcs8 -topk8 -nocrypt/);
    await expect(importAppKey("not a key")).rejects.toThrow(/BEGIN PRIVATE KEY/);
  });
});

describe("installation tokens", () => {
  async function setup() {
    const github = await hostedGitHub(keys);
    const { gh } = github;
    await gh.addRepo({ fullName: "player/notes", id: 9002 });
    const installation = gh.addInstallation({ account: { id: 4242, login: "player", type: "User" }, repos: ["player/vault", "player/notes"] });
    const app = new GitHubApp({ appId: APP.id, privateKey: keys.privateKeyPem, apiUrl: "https://api.github.test", fetch: github.fetch, now: () => gh.now() });
    return { ...github, installation, app };
  }

  it("narrows a token to one repo and the vault's permissions", async () => {
    const { gh, installation, app } = await setup();
    const { token, expiresAt } = await app.installationToken(installation.id, { repositoryIds: [9001], permissions: { contents: "write", metadata: "read" } });
    expect(gh.tokens.get(token)).toMatchObject({ installation: installation.id, repos: ["player/vault"], permissions: { contents: "write", metadata: "read" } });
    expect(expiresAt.getTime()).toBeGreaterThan(Date.now());
    expect((await app.installationRepositories(token)).map((r) => r.fullName)).toEqual(["player/vault"]);
    // GitHub refuses to widen a token beyond the installation.
    await expect(app.installationToken(installation.id, { permissions: { administration: "write" } })).rejects.toMatchObject({ status: 422 });
    await expect(app.installationToken(123456)).rejects.toMatchObject({ status: 404 });
  });

  it("reuses a token until it nears expiry, and mints again on refresh", async () => {
    const { installation, app } = await setup();
    const source = app.tokenSource(installation.id, { repositoryIds: [9001] });
    const first = await source();
    expect(await source()).toBe(first);
    expect(await source({ refresh: true })).not.toBe(first);
  });

  it("is refused without a valid app JWT", async () => {
    const { installation, fetch } = await setup();
    const stranger = new GitHubApp({ appId: APP.id, privateKey: (await appKeyPair()).privateKeyPem, apiUrl: "https://api.github.test", fetch });
    await expect(stranger.installationToken(installation.id)).rejects.toThrow(/GITHUB_APP_PRIVATE_KEY/);
  });

  it("lists a user's installations and their repos, and uninstalls", async () => {
    const { gh, installation, app } = await setup();
    gh.addUser({ login: "player", id: 4242, token: "ghu_player" });
    expect((await app.userInstallations("ghu_player")).map((i) => [i.id, i.account.login])).toEqual([[installation.id, "player"]]);
    expect((await app.installationRepos("ghu_player", installation.id)).map((r) => r.id)).toEqual([9001, 9002]);
    await app.deleteInstallation(installation.id);
    expect(gh.installations.has(installation.id)).toBe(false);
    await app.deleteInstallation(installation.id);
  });
});

describe("webhook signatures", () => {
  it("accepts GitHub's signature and nothing else", async () => {
    const body = JSON.stringify({ action: "deleted" });
    const signature = await signWebhook("hook-secret", body);
    expect(await verifyWebhook("hook-secret", body, signature)).toBe(true);
    expect(await verifyWebhook("hook-secret", `${body} `, signature)).toBe(false);
    expect(await verifyWebhook("other-secret", body, signature)).toBe(false);
    expect(await verifyWebhook("hook-secret", body, signature.replace("sha256=", "sha1="))).toBe(false);
    expect(await verifyWebhook("hook-secret", body, null)).toBe(false);
    expect(await verifyWebhook("", body, signature)).toBe(false);
  });
});
