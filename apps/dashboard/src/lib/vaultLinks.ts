// Links into the vault's repository on whichever host it lives: GitHub or GitLab.

export interface RepoRef {
  kind?: string;
  repo?: string;
  branch?: string;
  /** The repo's page on its host. */
  url?: string;
}

export interface RepoLinks {
  host: "GitHub" | "GitLab";
  repo: string;
  commits: string;
  blob: (path: string) => string;
}

const encodePath = (path: string) => path.split("/").map(encodeURIComponent).join("/");

/** Where the repo, its history and a file in it are on its host; none for a vault that isn't in a repo. */
export function repoLinks(vault: RepoRef | undefined): RepoLinks | undefined {
  if (!vault || (vault.kind !== "github" && vault.kind !== "gitlab") || !vault.repo) return undefined;
  const gitlab = vault.kind === "gitlab";
  const base = (vault.url ?? `${gitlab ? "https://gitlab.com" : "https://github.com"}/${encodePath(vault.repo)}`).replace(/\/$/, "");
  const branch = encodeURIComponent(vault.branch ?? "main");
  // GitLab keeps its pages under /-/.
  const mid = gitlab ? "/-" : "";
  return {
    host: gitlab ? "GitLab" : "GitHub",
    repo: base,
    commits: `${base}${mid}/commits/${branch}`,
    blob: (path) => `${base}${mid}/blob/${branch}/${encodePath(path)}`,
  };
}
