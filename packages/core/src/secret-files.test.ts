import { describe, expect, it } from "vitest";
import { fixtureStore } from "./__fixtures__/vault.ts";
import { CONFIG_PATH, parseConfig, setRecipient } from "./config.ts";
import { decryptSecret, encryptSecret, generateKeyPair } from "./secrets.ts";
import { HippoService } from "./service.ts";
import type { MemoryStore } from "./store.ts";

const now = () => new Date("2026-09-27T12:00:00.000Z");
const PASSPORT = "U12345678";
const PROPOSED = "U87654321";

/** A vault with one secret fact, one secret proposal and one file nothing points at, all locked to `recipient`. */
async function vault(recipient: string): Promise<MemoryStore> {
  const store = fixtureStore({
    "items/passport.md": `---\ntype: item\ntitle: Passport\nfacts:\n  number: { value: "secret://passport/number", status: canon, by: player, at: "2026-09-10T00:00:00Z", src: [ep-s] }\n---\n`,
    "disputes/proposal-passport-number.md": `---\ntype: dispute\nkind: proposal\nentity: "[[passport]]"\nfield: number\nstatus: open\nstate: pending\nclaims:\n  - { value: "secret://passport/number.ep-p", by: residency-agent, at: "2026-09-11T00:00:00Z", src: [ep-p] }\n---\n`,
    "secrets/passport/number.age": await encryptSecret(recipient, PASSPORT),
    "secrets/passport/number.ep-p.age": await encryptSecret(recipient, PROPOSED),
    "secrets/old/pin.age": await encryptSecret(recipient, "4321"),
  });
  await store.write(CONFIG_PATH, setRecipient((await store.read(CONFIG_PATH))!, recipient));
  return store;
}

describe("secret files for the owner's browser", () => {
  it("lists every ciphertext with the fact or proposal it holds, and no ref or value", async () => {
    const key = await generateKeyPair();
    const { recipient, files } = await new HippoService(await vault(key.recipient), { now }).secretFiles();
    expect(recipient).toBe(key.recipient);
    expect(files.map(({ armored: _, ...f }) => f)).toEqual([
      { path: "secrets/old/pin.age" },
      { path: "secrets/passport/number.age", entity: "passport", field: "number" },
      { path: "secrets/passport/number.ep-p.age", entity: "passport", field: "number", proposal: "proposal-passport-number" },
    ]);
    const json = JSON.stringify(files);
    expect(json).not.toContain("secret://");
    expect(json).not.toContain(PASSPORT);
    expect(await decryptSecret(key.identity, files.find((f) => f.path === "secrets/passport/number.age")!.armored)).toBe(PASSPORT);
  });
});

describe("rotating the secrets key", () => {
  /** What the browser does: open every file with the old key, lock it to the new one. */
  const reencrypt = async (service: HippoService, oldIdentity: string, recipient: string) =>
    Promise.all((await service.secretFiles()).files.map(async (f) => ({ path: f.path, armored: await encryptSecret(recipient, await decryptSecret(oldIdentity, f.armored)) })));

  it("moves every secret to the new key in one commit, and the old key opens none of them", async () => {
    const old = await generateKeyPair();
    const fresh = await generateKeyPair();
    const store = await vault(old.recipient);
    const service = new HippoService(store, { now });
    const files = await reencrypt(service, old.identity, fresh.recipient);
    expect(await service.rotateSecrets(fresh.recipient, files, { via: "@player" })).toMatchObject({ rotated: 3, message: expect.stringMatching(/^config\(player via @player\): rotate the secrets key \(3 secrets\)/) });
    expect(parseConfig((await store.read(CONFIG_PATH))!).secrets.recipient).toBe(fresh.recipient);
    expect(await decryptSecret(fresh.identity, (await store.read("secrets/passport/number.age"))!)).toBe(PASSPORT);
    expect(await decryptSecret(fresh.identity, (await store.read("secrets/passport/number.ep-p.age"))!)).toBe(PROPOSED);
    await expect(decryptSecret(old.identity, (await store.read("secrets/passport/number.age"))!)).rejects.toThrow();
  });

  it("refuses a partial or stale set, a path outside the secrets, plaintext, and the current key", async () => {
    const old = await generateKeyPair();
    const fresh = await generateKeyPair();
    const store = await vault(old.recipient);
    const service = new HippoService(store, { now });
    const files = await reencrypt(service, old.identity, fresh.recipient);
    await expect(service.rotateSecrets(fresh.recipient, files.slice(1))).rejects.toThrow(/secrets changed/);
    await expect(service.rotateSecrets(fresh.recipient, [...files, { path: "secrets/../_hippo/config.age", armored: files[0]!.armored }])).rejects.toThrow(/isn't a secret's file/);
    await expect(service.rotateSecrets(fresh.recipient, [...files.slice(1), { path: files[0]!.path, armored: PASSPORT }])).rejects.toThrow(/not age ciphertext/);
    await expect(service.rotateSecrets(old.recipient, files)).rejects.toThrow(/current key/);
    // A sleep stored a new secret meanwhile: the rotation would leave it under the old key.
    await store.write("secrets/visa/number.age", await encryptSecret(old.recipient, "V1"));
    await expect(service.rotateSecrets(fresh.recipient, files)).rejects.toThrow(/secrets changed/);
    expect(parseConfig((await store.read(CONFIG_PATH))!).secrets.recipient).toBe(old.recipient);
  });
});
