import { xsalsa20poly1305, hsalsa } from "@noble/ciphers/salsa.js";
import { x25519 } from "@noble/curves/ed25519.js";
import { blake2b } from "@noble/hashes/blake2.js";

// libsodium's `crypto_box_seal`, which GitHub requires for Actions secrets: a throwaway X25519 key
// pair, the nonce blake2b-192(ephemeral pk ‖ recipient pk), and crypto_box (HSalsa20 over the shared
// secret, then XSalsa20-Poly1305). Pure JS (the noble packages age-encryption already brings), so it
// runs in Workers without WASM.

/** "expand 32-byte k" as little-endian words, the constant HSalsa20 starts from. */
const SIGMA = new Uint32Array([0x61707865, 0x3320646e, 0x79622d32, 0x6b206574]);

const words = (bytes: Uint8Array) => {
  const out = new Uint32Array(bytes.length / 4);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let i = 0; i < out.length; i++) out[i] = view.getUint32(i * 4, true);
  return out;
};
const bytesOf = (w: Uint32Array) => {
  const out = new Uint8Array(w.length * 4);
  const view = new DataView(out.buffer);
  w.forEach((x, i) => view.setUint32(i * 4, x, true));
  return out;
};

/** crypto_box_beforenm: the box key two X25519 keys share. */
export function boxKey(secretKey: Uint8Array, publicKey: Uint8Array): Uint8Array {
  const shared = x25519.getSharedSecret(secretKey, publicKey);
  const out = new Uint32Array(8);
  hsalsa(SIGMA, words(shared), new Uint32Array(4), out);
  return bytesOf(out);
}

/** The sealed box's nonce: blake2b with a 24-byte digest over both public keys. */
export const sealNonce = (ephemeralPk: Uint8Array, recipientPk: Uint8Array) => blake2b(new Uint8Array([...ephemeralPk, ...recipientPk]), { dkLen: 24 });

/** `crypto_box_seal(message, recipient)`: ephemeral pk ‖ Poly1305 tag ‖ ciphertext. */
export function seal(message: Uint8Array, recipientPk: Uint8Array, ephemeralSk: Uint8Array = x25519.utils.randomSecretKey()): Uint8Array {
  if (recipientPk.length !== 32) throw new Error("seal: the recipient's key must be 32 bytes");
  const epk = x25519.getPublicKey(ephemeralSk);
  const box = xsalsa20poly1305(boxKey(ephemeralSk, recipientPk), sealNonce(epk, recipientPk)).encrypt(message);
  const out = new Uint8Array(32 + box.length);
  out.set(epk);
  out.set(box, 32);
  return out;
}

const fromBase64 = (b64: string) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
const toBase64 = (bytes: Uint8Array) => {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
};

/** A secret's value sealed for a repo's Actions public key (base64 in, base64 out), as `PUT actions/secrets/{name}` takes it. */
export const sealForGitHub = (value: string, publicKeyBase64: string): string => toBase64(seal(new TextEncoder().encode(value), fromBase64(publicKeyBase64)));
