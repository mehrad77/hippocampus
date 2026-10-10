import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { FsStore } from "./node/fs-store.ts";
import { storeContract } from "./store.contract.ts";
import { bufferedStore, MemoryStore } from "./store.ts";

storeContract("MemoryStore", async (files) => new MemoryStore(files));

storeContract("bufferedStore", async (files) => bufferedStore(new MemoryStore(files)).store);

describe("bufferedStore", () => {
  it("collects what would change, leaving the base alone", async () => {
    const base = new MemoryStore({ "lore/visa.md": "v1", "goals/permit.md": "p", "party/home-finder.md": "h" });
    const { store, changes } = bufferedStore(base);
    await store.write("lore/visa.md", "v2");
    await store.remove("goals/permit.md");
    await store.write("arcs/lisbon-arc.md", "a");
    await store.write("party/home-finder.md", "h");
    await store.write("tmp.md", "x");
    await store.remove("tmp.md");
    expect(await store.read("lore/visa.md")).toBe("v2");
    expect(await store.list("goals")).toEqual([]);
    expect(await changes()).toEqual([
      { path: "arcs/lisbon-arc.md", content: "a" },
      { path: "goals/permit.md", remove: true },
      { path: "lore/visa.md", content: "v2" },
    ]);
    expect(base.files.get("lore/visa.md")).toBe("v1");
  });
});

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
