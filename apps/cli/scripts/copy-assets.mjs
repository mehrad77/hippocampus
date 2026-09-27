// Copies the vault template, example seeds, README and LICENSE into the package for publishing.
import { cp, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const pkg = join(dirname(fileURLToPath(import.meta.url)), "..");
const root = join(pkg, "../..");
for (const dir of ["vault-template", "seeds"]) {
  await rm(join(pkg, dir), { recursive: true, force: true });
  await cp(join(root, dir), join(pkg, dir), { recursive: true });
}
for (const file of ["README.md", "LICENSE"]) await cp(join(root, file), join(pkg, file));
// npm strips .gitignore files from packages; ship it under another name (`hippo init` restores it).
await rename(join(pkg, "vault-template/.gitignore"), join(pkg, "vault-template/gitignore"));
