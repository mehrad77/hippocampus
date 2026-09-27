import { Decrypter, Encrypter, armor, generateX25519Identity, identityToRecipient } from "age-encryption";

/**
 * Secret fact values live in `secrets/<entity>/<field>.age` (armored age, one file per field),
 * and the note stores `secret://<entity>/<field>`. Encrypting needs only the public recipient,
 * so the curator can store secrets without being able to read them back.
 */
export const SECRET_SCHEME = "secret://";

export function secretRef(entity: string, field: string): string {
  return `${SECRET_SCHEME}${entity}/${field}`;
}

export function isSecretRef(value: unknown): value is string {
  return typeof value === "string" && value.startsWith(SECRET_SCHEME);
}

export function secretPath(secretsFolder: string, ref: string): string {
  return `${secretsFolder}/${ref.slice(SECRET_SCHEME.length)}.age`;
}

export async function encryptSecret(recipient: string, plaintext: string): Promise<string> {
  const e = new Encrypter();
  e.addRecipient(recipient);
  return armor.encode(await e.encrypt(plaintext));
}

export async function decryptSecret(identity: string, armored: string): Promise<string> {
  const d = new Decrypter();
  d.addIdentity(identity);
  return d.decrypt(armor.decode(armored), "text");
}

export async function generateKeyPair(): Promise<{ identity: string; recipient: string }> {
  const identity = await generateX25519Identity();
  return { identity, recipient: await identityToRecipient(identity) };
}

/** Replace literal occurrences of secret values in free text (e.g. before archiving an episode). */
export function redact(text: string, values: string[]): string {
  let out = text;
  for (const v of values) if (v.trim().length >= 3) out = out.split(v).join("[redacted]");
  return out;
}
