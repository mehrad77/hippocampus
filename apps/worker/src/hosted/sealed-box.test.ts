import nacl from "tweetnacl";
import { describe, expect, it } from "vitest";
import { boxKey, seal, sealForGitHub, sealNonce } from "./sealed-box.ts";

const hex = (s: string) => Uint8Array.from(s.match(/../g)!, (h) => parseInt(h, 16));
const fromBase64 = (b64: string) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));

/** Opens a sealed box with tweetnacl, an implementation independent of the one that sealed it. */
function open(sealed: Uint8Array, pk: Uint8Array, sk: Uint8Array): string | undefined {
  const epk = sealed.subarray(0, 32);
  const opened = nacl.box.open(sealed.subarray(32), sealNonce(epk, pk), epk, sk);
  return opened ? new TextDecoder().decode(opened) : undefined;
}

describe("crypto_box_seal", () => {
  it("derives NaCl's box key (the crypto_box test vector)", () => {
    const aliceSk = hex("77076d0a7318a57d3c16c17251b26645df4c2f87ebc0992ab177fba51db92c2a");
    const bobPk = hex("de9edb7d7b7dc1b4d35b61c2ece435373f8343c85b78674dadfc7e146f882b4f");
    expect(Buffer.from(boxKey(aliceSk, bobPk)).toString("hex")).toBe("1b27556473e985d462cd51197a9a46c76009549eac6474f206c4ee0844f68389");
  });

  it("seals what tweetnacl opens with the recipient's key, and nothing else does", () => {
    const recipient = nacl.box.keyPair();
    const value = "sk-ant-api03-residency-agent-example";
    const sealed = fromBase64(sealForGitHub(value, btoa(String.fromCharCode(...recipient.publicKey))));
    expect(sealed.length).toBe(32 + 16 + value.length);
    expect(open(sealed, recipient.publicKey, recipient.secretKey)).toBe(value);
    const other = nacl.box.keyPair();
    expect(open(sealed, other.publicKey, other.secretKey)).toBeUndefined();
  });

  it("uses a fresh ephemeral key each time", () => {
    const { publicKey } = nacl.box.keyPair();
    const m = new TextEncoder().encode("same");
    expect(seal(m, publicKey).subarray(0, 32)).not.toEqual(seal(m, publicKey).subarray(0, 32));
    expect(() => seal(m, new Uint8Array(31))).toThrow(/32 bytes/);
  });
});
