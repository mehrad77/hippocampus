import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { FsStore } from "./node/fs-store.ts";
import { storeContract } from "./store.contract.ts";
import { MemoryStore } from "./store.ts";

storeContract("MemoryStore", async (files) => new MemoryStore(files));

storeContract(
  "FsStore",
  async (files) => {
    const root = await mkdtemp(join(tmpdir(), "hippo-store-"));
    for (const [path, content] of Object.entries(files)) {
      await mkdir(dirname(join(root, path)), { recursive: true });
      await writeFile(join(root, path), content);
    }
    return new FsStore(root);
  },
  { ignoresEditorFiles: true },
);
