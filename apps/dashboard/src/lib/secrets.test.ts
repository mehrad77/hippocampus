import { describe, expect, it } from "vitest";
import { decryptArmored, encryptArmored, identityFrom, recipientOf } from "./secrets.ts";
import { generateX25519Identity, identityToRecipient } from "age-encryption";

describe("key files in the browser", () => {
  it("finds the private key in our download and in age-keygen output", async () => {
    const identity = await generateX25519Identity();
    const recipient = await identityToRecipient(identity);
    expect(identityFrom(`${identity}\n`)).toBe(identity);
    expect(identityFrom(`# created: 2026-10-11T12:00:00Z\n# public key: ${recipient}\n${identity}\n`)).toBe(identity);
    expect(await recipientOf(identity)).toBe(recipient);
  });

  it("says so when the file holds only a public key, or no key at all", async () => {
    const recipient = await identityToRecipient(await generateX25519Identity());
    expect(() => identityFrom(recipient)).toThrow(/That's the public key/);
    expect(() => identityFrom("hello")).toThrow(/No private key/);
  });

  it("opens what it locked, and a different key opens nothing", async () => {
    const identity = await generateX25519Identity();
    const armored = await encryptArmored(await identityToRecipient(identity), "U12345678");
    expect(armored).toMatch(/^-----BEGIN AGE ENCRYPTED FILE-----/);
    expect(await decryptArmored(identity, armored)).toBe("U12345678");
    await expect(decryptArmored(await generateX25519Identity(), armored)).rejects.toThrow();
  });
});
