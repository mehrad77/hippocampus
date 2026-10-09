import { describe, expect, it } from "vitest";
import { applyChanges, type VaultStore } from "./store.ts";

/** Behaviour every `VaultStore` adapter must share. Run it from each adapter's tests. */
export function storeContract(name: string, make: (files: Record<string, string>) => Promise<VaultStore>, opts: { ignoresEditorFiles?: boolean } = {}): void {
  const seed = {
    "_hippo/config.yaml": "version: 1\n",
    "characters/player.md": "# Player\n",
    "inbox/residency-agent/2026-09-27T100000-a.md": "agency appointment\n",
    "inbox/campus-agent/2026-09-27T110000-b.md": "João Silva · ı İ\n",
    "inbox-archive/old.md": "not in the inbox\n",
  };

  describe(`VaultStore contract: ${name}`, () => {
    it("lists every file, sorted", async () => {
      const store = await make(seed);
      expect(await store.list()).toEqual(Object.keys(seed).sort());
    });

    it("lists by directory, not by string prefix", async () => {
      const store = await make(seed);
      expect(await store.list("inbox")).toEqual(["inbox/campus-agent/2026-09-27T110000-b.md", "inbox/residency-agent/2026-09-27T100000-a.md"]);
      expect(await store.list("inbox/")).toEqual(await store.list("inbox"));
      expect(await store.list("nowhere")).toEqual([]);
    });

    it("reads UTF-8 content and undefined for missing files", async () => {
      const store = await make(seed);
      expect(await store.read("inbox/campus-agent/2026-09-27T110000-b.md")).toBe("João Silva · ı İ\n");
      expect(await store.read("characters/nobody.md")).toBeUndefined();
    });

    it("reads its own writes and removals", async () => {
      const store = await make(seed);
      await store.write("characters/joao-silva.md", "# João\n");
      await store.write("characters/player.md", "# Player 2\n");
      await store.remove("inbox/residency-agent/2026-09-27T100000-a.md");
      expect(await store.read("characters/joao-silva.md")).toBe("# João\n");
      expect(await store.read("characters/player.md")).toBe("# Player 2\n");
      expect(await store.read("inbox/residency-agent/2026-09-27T100000-a.md")).toBeUndefined();
      expect(await store.list("characters")).toEqual(["characters/joao-silva.md", "characters/player.md"]);
      expect(await store.list("inbox")).toEqual(["inbox/campus-agent/2026-09-27T110000-b.md"]);
    });

    it("removes missing files without complaint", async () => {
      const store = await make(seed);
      await expect(store.remove("characters/nobody.md")).resolves.toBeUndefined();
    });

    it("applies a batch of writes and removals", async () => {
      const store = await make(seed);
      await applyChanges(
        store,
        [
          { path: "factions/migration-agency.md", content: "# Agency\n" },
          { path: "inbox/campus-agent/2026-09-27T110000-b.md", remove: true },
          { path: "characters/nobody.md", remove: true },
        ],
        { message: "test: batch" },
      );
      expect(await store.read("factions/migration-agency.md")).toBe("# Agency\n");
      expect(await store.list("inbox")).toEqual(["inbox/residency-agent/2026-09-27T100000-a.md"]);
    });

    if (opts.ignoresEditorFiles) {
      it("ignores editor and VCS internals", async () => {
        const store = await make({ ...seed, ".obsidian/app.json": "{}", "characters/.trash/x.md": "x" });
        expect(await store.list()).toEqual(Object.keys(seed).sort());
      });
    }
  });
}
