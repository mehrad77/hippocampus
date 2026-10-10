import { VaultError } from "@hippocampus/core";

/** The repo has no commits, so the host refuses reads of a branch. A store's `initialize()` makes the first one. */
export class EmptyRepositoryError extends VaultError {
  constructor(readonly repo: string) {
    super(`${repo} is empty: it has no commits yet`);
    this.name = "EmptyRepositoryError";
  }
}
