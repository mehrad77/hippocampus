import { describe, expect, it } from "vitest";
import { fixtureStore } from "./__fixtures__/vault.ts";
import { CONFIG_PATH, parseConfig, setRecipient } from "./config.ts";
import { HANDBOOK_PATH } from "./handbook.ts";
import { generateKeyPair } from "./secrets.ts";
import { HippoService } from "./service.ts";
import { Vault } from "./vault.ts";
import { renderOnboarding } from "./handbook.ts";

const now = () => new Date("2026-09-27T12:00:00.000Z");

describe("setting the secrets recipient", () => {
  const raw = "version: 2\nname: lisbon-arc\n# Secrets are encrypted to this key.\nsecrets:\n  recipient: null\n";

  it("sets it, keeping the comment, and is a no-op for the same key", async () => {
    const { recipient } = await generateKeyPair();
    const next = setRecipient(raw, recipient);
    expect(next).toContain("# Secrets are encrypted to this key.");
    expect(parseConfig(next).secrets.recipient).toBe(recipient);
    expect(setRecipient(next, recipient)).toBe(next);
  });

  it("refuses what isn't an age public key, and a different key unless told to replace", async () => {
    expect(() => setRecipient(raw, "AGE-SECRET-KEY-1ABC")).toThrow(/age public key/);
    const a = await generateKeyPair();
    const b = await generateKeyPair();
    const next = setRecipient(raw, a.recipient);
    expect(() => setRecipient(next, b.recipient)).toThrow(/already has a secrets recipient/);
    expect(parseConfig(setRecipient(next, b.recipient, { replace: true })).secrets.recipient).toBe(b.recipient);
  });

  it("HippoService commits the config and the Handbook, which stops warning agents", async () => {
    const { recipient } = await generateKeyPair();
    const store = fixtureStore();
    const service = new HippoService(store, { now });
    expect(await service.setSecretsRecipient(recipient, { via: "@player" })).toMatchObject({ changed: true });
    expect(parseConfig((await store.read(CONFIG_PATH))!).secrets.recipient).toBe(recipient);
    expect(await store.read(HANDBOOK_PATH)).not.toContain("no secrets recipient yet");
    expect(await service.setSecretsRecipient(recipient)).toEqual({ changed: false });
  });

  it("the Handbook warns agents while there is no recipient", async () => {
    const store = fixtureStore();
    await new HippoService(store, { now }).addDomains(["health"]);
    expect(await store.read(HANDBOOK_PATH)).toContain("no secrets recipient yet");
  });

  it("onboarding tells an agent how the person sets it, and whether it already is", async () => {
    const store = fixtureStore();
    expect(renderOnboarding(await Vault.load(store, { now }), "residency-agent")).toContain("not set, so secret facts are held back");
    await new HippoService(store, { now }).setSecretsRecipient((await generateKeyPair()).recipient);
    expect(renderOnboarding(await Vault.load(store, { now }), "residency-agent")).toContain("already set, so secret facts are stored");
  });
});
