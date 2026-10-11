// Which of the person's vaults this tab shows (hosted app only). Each tab keeps its own choice, so
// two tabs can show two vaults; a new tab opens the one the server says was used last. A link can
// name one with `?vault=<id>`, which wins and becomes the tab's choice.

/** The request header naming the vault; the same as `VAULT_HEADER` in @hippocampus/dashboard (this bundle takes only types from there). */
export const VAULT_HEADER = "x-hippo-vault";
const KEY = "hippo:vault";
const VAULT_ID = /^[0-9A-HJKMNP-TV-Z]{26}$/;

function store(): Storage | undefined {
  try {
    return sessionStorage;
  } catch {
    return undefined;
  }
}

/** A vault id named in `search` (`?vault=`), if it looks like one. */
export function vaultFromSearch(search: string): string | undefined {
  const id = new URLSearchParams(search).get("vault")?.trim().toUpperCase();
  return id && VAULT_ID.test(id) ? id : undefined;
}

/** The tab's vault: the one the address names, else the one chosen earlier in this tab. */
export function chosenVault(): string | undefined {
  const named = typeof location === "undefined" ? undefined : vaultFromSearch(location.search);
  if (named) {
    store()?.setItem(KEY, named);
    return named;
  }
  const kept = store()?.getItem(KEY) ?? undefined;
  return kept && VAULT_ID.test(kept) ? kept : undefined;
}

/** Headers that tell the server which vault a request is about. */
export function vaultHeaders(): Record<string, string> {
  const id = chosenVault();
  return id ? { [VAULT_HEADER]: id } : {};
}

/** Forget the tab's choice (its vault was removed): the server's default applies again. */
export function forgetVault(): void {
  try {
    store()?.removeItem(KEY);
  } catch {
    // Storage off: nothing was kept.
  }
}

/** The address without `?vault=`, so a reload doesn't pin the tab back to it. */
export function withoutVaultParam(href: string): string {
  const url = new URL(href);
  url.searchParams.delete("vault");
  return url.pathname + url.search + url.hash;
}

/** Switch this tab to another vault and reload, at `to` or where it is. */
export function switchVault(id: string, to?: string): void {
  stopAddingVault();
  try {
    store()?.setItem(KEY, id);
  } catch {
    // Storage off: the address carries it instead.
    location.assign(`${to ?? location.pathname}?vault=${encodeURIComponent(id)}`);
    return;
  }
  location.assign(to ?? withoutVaultParam(location.href));
}

const ADDING = "hippo:adding-vault";
/** The setup steps of adding a vault; GitHub and GitLab send people back to one of them (`#repo`), without `?add`. */
const ADD_STEPS = new Set(["create", "install", "repo", "campaign", "init"]);

/**
 * Whether this tab is adding another vault: `?add` on the setup page, or a step of it after a trip to
 * GitHub or GitLab (which drop the query). Ends with the new vault, or on the plain setup page.
 */
export function addingVaultNow(search: string, hash: string): boolean {
  const s = store();
  if (new URLSearchParams(search).has("add")) {
    try {
      s?.setItem(ADDING, "1");
    } catch {
      // Storage off: `?add` still works, until GitHub drops it.
    }
    return true;
  }
  return s?.getItem(ADDING) === "1" && ADD_STEPS.has(hash.replace(/^#/, ""));
}

/** Done adding (or never mind). */
export function stopAddingVault(): void {
  try {
    store()?.removeItem(ADDING);
  } catch {
    // Storage off: nothing was kept.
  }
}
