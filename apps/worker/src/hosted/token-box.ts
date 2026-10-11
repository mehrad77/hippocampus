// Seals small JSON secrets (a GitLab connection's tokens) for the registry: AES-256-GCM under the
// Worker's HIPPO_TOKEN_KEY. The associated data binds a sealed value to its owner, so one row's
// secret can't be copied onto another account's row.

const VERSION = "v1";

const toB64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const fromB64 = (s: string) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));

/** A key from its secret: 32 random bytes, base64 (`openssl rand -base64 32`). */
export function checkTokenKey(secret: string): Uint8Array {
  let bytes: Uint8Array;
  try {
    bytes = fromB64(secret.trim().replace(/=+$/, ""));
  } catch {
    throw new Error("HIPPO_TOKEN_KEY must be base64: generate one with `openssl rand -base64 32`");
  }
  if (bytes.length !== 32) throw new Error("HIPPO_TOKEN_KEY must be 32 bytes (base64): generate one with `openssl rand -base64 32`");
  return bytes;
}

const importKey = (secret: string) => crypto.subtle.importKey("raw", checkTokenKey(secret) as Uint8Array<ArrayBuffer>, "AES-GCM", false, ["encrypt", "decrypt"]);

export async function seal(secret: string, aad: string, value: unknown): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = new TextEncoder().encode(JSON.stringify(value));
  const sealed = await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: new TextEncoder().encode(aad) }, await importKey(secret), data);
  return `${VERSION}.${toB64(iv)}.${toB64(new Uint8Array(sealed))}`;
}

/** The value, or undefined when `sealed` isn't ours, was sealed for another owner or under another key. */
export async function open<T>(secret: string, aad: string, sealed: string): Promise<T | undefined> {
  const [version, iv, body] = sealed.split(".");
  if (version !== VERSION || !iv || !body) return undefined;
  try {
    const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: fromB64(iv) as Uint8Array<ArrayBuffer>, additionalData: new TextEncoder().encode(aad) }, await importKey(secret), fromB64(body) as Uint8Array<ArrayBuffer>);
    return JSON.parse(new TextDecoder().decode(plain)) as T;
  } catch {
    return undefined;
  }
}
