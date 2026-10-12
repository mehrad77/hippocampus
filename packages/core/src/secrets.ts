import { Decrypter, Encrypter, armor, generateX25519Identity, identityToRecipient } from "age-encryption";

/**
 * Secret fact values live in `secrets/<entity>/<field>.age` (armored age, one file per field),
 * and the note stores `secret://<entity>/<field>`. Encrypting needs only the public recipient,
 * so the curator can store secrets without being able to read them back.
 */
export const SECRET_SCHEME = "secret://";

/** How every ciphertext file starts: armored age. */
export const AGE_ARMOR = "-----BEGIN AGE ENCRYPTED FILE-----";

/** A scoped key's `:` (`pin@org:harbor`) is stored as `~`, which no scope contains, so file names stay portable. */
export function secretRef(entity: string, field: string): string {
  return `${SECRET_SCHEME}${entity}/${field.replace(/:/g, "~")}`;
}

/** The `facts:` key a secret file name stands for (the inverse of `secretRef`'s encoding). */
export function secretFieldOf(fileField: string): string {
  return fileField.replace(/~/g, ":");
}

export function isSecretRef(value: unknown): value is string {
  return typeof value === "string" && value.startsWith(SECRET_SCHEME);
}

/**
 * The file a ref's ciphertext lives in. A `suffix` names a sibling file for a value that isn't the
 * field's own yet, like a proposal waiting for the human (`<field>.<episode>.age`); its ref is
 * `${ref}.${suffix}`, so `secretPath(folder, ref, s) === secretPath(folder, `${ref}.${s}`)`.
 */
export function secretPath(secretsFolder: string, ref: string, suffix?: string): string {
  return `${secretsFolder}/${ref.slice(SECRET_SCHEME.length)}${suffix ? `.${suffix}` : ""}.age`;
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
