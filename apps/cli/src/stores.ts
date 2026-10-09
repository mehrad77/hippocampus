import { resolve } from "node:path";
import type { SearcherFactory, VaultStore } from "@hippocampus/core";
import { FsStore } from "@hippocampus/core/node";
import { createEmbedder, embedConfigFromEnv } from "@hippocampus/embeddings";
import { HippoIndex, type IndexOptions } from "@hippocampus/index";
import { nodeSqlite } from "@hippocampus/index/node";
import { GitHubStore } from "@hippocampus/store-github";
import { expandHome, indexPath, type Env } from "./paths.ts";

/** `owner/repo[#branch]` → its parts. */
export function parseRepo(spec: string): { repo: string; branch?: string } {
  const [repo, branch] = spec.split("#");
  return { repo: repo!, branch: branch || undefined };
}

export const githubToken = (env: Env) => env.HIPPO_GITHUB_TOKEN ?? env.GITHUB_TOKEN;

/** The vault: a GitHub repo with `github`, else the local directory. */
export function openStore(opts: { dir?: string; github?: string; token?: string; env?: Env }): VaultStore {
  const env = opts.env ?? process.env;
  if (!opts.github) return new FsStore(resolve(expandHome(opts.dir ?? ".")));
  const token = opts.token ?? githubToken(env);
  if (!token) throw new Error("--github needs a token in HIPPO_GITHUB_TOKEN (fine-grained, Contents: read and write on the vault repo)");
  const { repo, branch } = parseRepo(opts.github);
  return new GitHubStore({ repo, branch, token, apiUrl: env.HIPPO_GITHUB_API_URL });
}

/** Semantic recall when `HIPPO_EMBED_MODEL` is set; keyword search otherwise. */
export function indexOptions(env: Env = process.env): IndexOptions {
  const cfg = embedConfigFromEnv(env);
  return cfg ? { embedder: createEmbedder(cfg), minSimilarity: cfg.minSimilarity } : {};
}

export interface OpenIndex {
  index: HippoIndex;
  path: string;
  options: IndexOptions;
  close(): void;
}

/** The persistent index for a vault key (see `indexKey`), with a handle to close its database. */
export async function openIndex(key: string, env: Env = process.env): Promise<OpenIndex> {
  const path = indexPath(key, env);
  const db = nodeSqlite(path);
  const options = indexOptions(env);
  const index = await HippoIndex.open(db, options);
  return { index, path, options, close: () => db.close?.() };
}

export async function openSearcher(key: string, opts: { index: boolean; env?: Env }): Promise<SearcherFactory | undefined> {
  if (!opts.index) return undefined;
  return (await openIndex(key, opts.env)).index.searcher;
}
