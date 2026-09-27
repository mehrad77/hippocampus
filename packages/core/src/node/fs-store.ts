import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, relative, sep } from "node:path";
import type { VaultStore } from "../store.ts";

const IGNORED = new Set([".git", ".obsidian", ".trash", "node_modules"]);

export class FsStore implements VaultStore {
  constructor(readonly root: string) {}

  async list(prefix = ""): Promise<string[]> {
    const out: string[] = [];
    const walk = async (dir: string) => {
      let entries;
      try {
        entries = await readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        if (IGNORED.has(e.name)) continue;
        const full = join(dir, e.name);
        if (e.isDirectory()) await walk(full);
        else if (e.isFile()) out.push(relative(this.root, full).split(sep).join("/"));
      }
    };
    await walk(join(this.root, prefix));
    return out.sort();
  }

  async read(path: string): Promise<string | undefined> {
    try {
      return await readFile(join(this.root, path), "utf8");
    } catch {
      return undefined;
    }
  }

  async write(path: string, content: string): Promise<void> {
    const full = join(this.root, path);
    await mkdir(dirname(full), { recursive: true });
    await writeFile(full, content, "utf8");
  }

  async remove(path: string): Promise<void> {
    await rm(join(this.root, path), { force: true });
  }
}
