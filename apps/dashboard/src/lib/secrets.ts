// Opening and moving secrets in the browser. The private key comes from a file the person picks, lives in memory
// for as long as the dialog using it is open, and is never sent anywhere: the server only ever sees ciphertext.

const SECRET_KEY = /AGE-SECRET-KEY-1[0-9A-Z]+/;

/**
 * The private key in a key file's text: our `.agekey` download, or `age-keygen` output with its `#` comment lines.
 * Throws with a message for the person when there is none (a public key, or some other file).
 */
export function identityFrom(text: string): string {
  const found = text.match(SECRET_KEY);
  if (found) return found[0];
  if (/\bage1[02-9ac-hj-np-z]{58}\b/.test(text)) throw new Error("That's the public key. Pick the key file you downloaded: it holds a line starting with AGE-SECRET-KEY-1.");
  throw new Error("No private key in that file. Pick the key file you downloaded: it holds a line starting with AGE-SECRET-KEY-1.");
}

const age = () => import("age-encryption");

/** The public key (`age1…`) a private key goes with, to tell a wrong key file apart from a damaged secret. */
export async function recipientOf(identity: string): Promise<string> {
  return (await age()).identityToRecipient(identity);
}

export async function decryptArmored(identity: string, armored: string): Promise<string> {
  const { Decrypter, armor } = await age();
  const d = new Decrypter();
  d.addIdentity(identity);
  return d.decrypt(armor.decode(armored), "text");
}

export async function encryptArmored(recipient: string, plaintext: string): Promise<string> {
  const { Encrypter, armor } = await age();
  const e = new Encrypter();
  e.addRecipient(recipient);
  return armor.encode(await e.encrypt(plaintext));
}
