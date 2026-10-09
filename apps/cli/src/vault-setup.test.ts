import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CONFIG_PATH, Vault, parseConfig } from "@hippocampus/core";
import { FsStore } from "@hippocampus/core/node";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { assetRoot } from "./paths.ts";
import { IdentityExistsError, initVault, keygen, localRecipient } from "./vault-setup.ts";

let tmp: string;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "hippo-setup-"));
});
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

describe("initVault", () => {
  it("fills in the config (keeping its comments) and gives the template PC to the human", async () => {
    const target = join(tmp, "lisbon-arc");
    const r = await initVault({ target, assets: assetRoot(), campaign: "lisbon-arc", human: "student", timezone: "Europe/Lisbon", domains: ["residency", "housing"] });
    expect(r).toEqual({ dir: target, campaign: "lisbon-arc", human: "student" });

    const raw = readFileSync(join(target, CONFIG_PATH), "utf8");
    expect(raw).toContain("# Party id of the human player.");
    expect(raw).toMatch(/^domains: \[ ?residency, housing ?\]$/m);
    const config = parseConfig(raw);
    expect(config).toMatchObject({ campaign: "lisbon-arc", human: "student", timezone: "Europe/Lisbon", domains: ["residency", "housing"] });

    expect(existsSync(join(target, "characters/player.md"))).toBe(false);
    const vault = await Vault.load(new FsStore(target));
    expect(vault.entities.get("student")?.fm).toMatchObject({ type: "character", title: "Student", tags: ["pc"] });
    expect(existsSync(join(target, "HANDBOOK.md"))).toBe(true);
    expect(existsSync(join(target, ".gitignore"))).toBe(true);
    expect(existsSync(join(target, ".git"))).toBe(true);
  });

  it("copies a bundled seed and keeps its own player character", async () => {
    const target = join(tmp, "demo");
    await initVault({ target, seed: "example-relocation", assets: assetRoot() });
    const vault = await Vault.load(new FsStore(target));
    expect(vault.config.campaign).toBe("lisbon-arc");
    expect(vault.entities.has("player")).toBe(true);
    expect(vault.entities.has("residency-agent")).toBe(true);
  });

  it("accepts an empty clone but refuses folders in use, existing vaults and the tool's own checkout", async () => {
    const clone = join(tmp, "clone");
    mkdirSync(join(clone, ".git"), { recursive: true });
    await expect(initVault({ target: clone, assets: assetRoot() })).resolves.toMatchObject({ dir: clone });
    await expect(initVault({ target: clone, assets: assetRoot() })).rejects.toThrow(/already has _hippo\/config.yaml/);

    const busy = join(tmp, "busy");
    mkdirSync(busy);
    writeFileSync(join(busy, "notes.txt"), "mine");
    await expect(initVault({ target: busy, assets: assetRoot() })).rejects.toThrow(/not empty/);

    const inRepo = join(assetRoot(), "vaults-test-should-not-exist");
    await expect(initVault({ target: inRepo, assets: assetRoot() })).rejects.toThrow(/inside the Hippocampus tool/);
    expect(existsSync(inRepo)).toBe(false);

    await expect(initVault({ target: join(tmp, "a"), assets: assetRoot(), human: "Not An Id" })).rejects.toThrow(/must be an id/);
    await expect(initVault({ target: join(tmp, "b"), assets: assetRoot(), timezone: "Mars/Olympus" })).rejects.toThrow(/unknown timezone/);
    expect(existsSync(join(tmp, "a"))).toBe(false);
  });
});

describe("keygen", () => {
  it("creates a private identity, sets the recipient, and never overwrites it", async () => {
    const target = join(tmp, "vault");
    await initVault({ target, assets: assetRoot() });
    const store = new FsStore(target);
    const identityFile = join(tmp, "config", "age-identity.txt");

    const first = await keygen({ store, identityFile });
    expect(first.created).toBe(true);
    expect(first.recipient).toMatch(/^age1/);
    expect(statSync(identityFile).mode & 0o777).toBe(0o600);
    expect(parseConfig(await store.read(CONFIG_PATH)).secrets.recipient).toBe(first.recipient);
    expect(await localRecipient(identityFile)).toBe(first.recipient);
    expect(readFileSync(join(target, CONFIG_PATH), "utf8")).toContain("# age public key");

    const identity = readFileSync(identityFile, "utf8");
    await expect(keygen({ store, identityFile })).rejects.toBeInstanceOf(IdentityExistsError);
    const again = await keygen({ store: new FsStore(join(tmp, "missing")), identityFile, reuseExisting: true }).catch((e: Error) => e);
    expect(again).toBeInstanceOf(Error);

    const other = join(tmp, "second");
    await initVault({ target: other, assets: assetRoot() });
    const reused = await keygen({ store: new FsStore(other), identityFile, reuseExisting: true });
    expect(reused).toEqual({ identityFile, recipient: first.recipient, created: false });
    expect(readFileSync(identityFile, "utf8")).toBe(identity);
  });
});
