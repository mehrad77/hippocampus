import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { CONFIG_PATH, Vault, buildVaultFiles, parseConfig } from "@hippocampus/core";
import { FsStore } from "@hippocampus/core/node";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { assetRoot } from "./paths.ts";
import { IdentityExistsError, initVault, keygen, localRecipient } from "./vault-setup.ts";

let tmp: string;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "hippo-setup-"));
});
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

/** Every file under `dir` except git's own, as text. */
function readTree(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const rel of readdirSync(dir, { recursive: true, encoding: "utf8" })) {
    const path = rel.split(sep).join("/");
    if (path === ".git" || path.startsWith(".git/") || !statSync(join(dir, rel)).isFile()) continue;
    out[path] = readFileSync(join(dir, rel), "utf8");
  }
  return out;
}

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

  it("writes exactly the files buildVaultFiles builds, the same vault the hosted app creates", async () => {
    // The repo's own template, not assetRoot(): that can be a stale copy left by a local `pnpm build`.
    const repo = join(import.meta.dirname, "../../..");
    const template = readTree(join(repo, "vault-template"));
    const seed = readTree(join(repo, "seeds", "example-relocation"));
    // As published: npm strips .gitignore files, so the package ships it as `gitignore`.
    const packed = join(tmp, "packed");
    cpSync(join(repo, "vault-template"), join(packed, "vault-template"), { recursive: true });
    renameSync(join(packed, "vault-template", ".gitignore"), join(packed, "vault-template", "gitignore"));
    cpSync(join(repo, "seeds"), join(packed, "seeds"), { recursive: true });

    const settings = { campaign: "lisbon-arc", human: "student", timezone: "Europe/Lisbon", domains: ["residency", "housing"] };
    const cases = [
      { name: "default", assets: repo, init: {}, build: {} },
      { name: "configured", assets: repo, init: settings, build: settings },
      { name: "seeded", assets: repo, init: { seed: "example-relocation" }, build: { seed } },
      { name: "packed", assets: packed, init: { ...settings, seed: "example-relocation" }, build: { ...settings, seed } },
    ];
    for (const c of cases) {
      const target = join(tmp, "vaults", c.name);
      await initVault({ target, assets: c.assets, ...c.init });
      expect(readTree(target), c.name).toEqual(await buildVaultFiles(template, c.build));
    }
  });

  it("copies a seed's binary files byte for byte", async () => {
    const seed = join(tmp, "seed");
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0xff, 0x00, 0xfe]);
    mkdirSync(join(seed, "attachments"), { recursive: true });
    writeFileSync(join(seed, "attachments", "map.png"), png);
    const target = join(tmp, "vault");
    await initVault({ target, seed, assets: assetRoot() });
    expect(readFileSync(join(target, "attachments", "map.png"))).toEqual(png);
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
