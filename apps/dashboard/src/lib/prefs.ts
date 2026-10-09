import { useCallback, useSyncExternalStore } from "react";
import { term, type Look, type TermKey } from "./terms.ts";

// How this browser shows the dashboard: look (plain or codex), color mode and text size. Stored in
// localStorage and mirrored on <html> (data-style, data-theme, data-text) by public/theme.js before
// the first paint, so there's no flash. These are per-browser conveniences, never vault data.

export type Mode = "system" | "light" | "dark";
export type TextSize = "standard" | "large";

export interface Prefs {
  look: Look;
  mode: Mode;
  text: TextSize;
}

const KEYS = { look: "hippo:look", mode: "hippo:theme", text: "hippo:text" } as const;
const EVENT = "hippo:prefs";

export function readPrefs(): Prefs {
  if (typeof document === "undefined") return { look: "plain", mode: "system", text: "standard" };
  const root = document.documentElement;
  const theme = root.getAttribute("data-theme");
  return {
    look: root.getAttribute("data-style") === "codex" ? "codex" : "plain",
    mode: theme === "light" || theme === "dark" ? theme : "system",
    text: root.getAttribute("data-text") === "large" ? "large" : "standard",
  };
}

function apply(p: Prefs): void {
  const root = document.documentElement;
  if (p.look === "codex") root.setAttribute("data-style", "codex");
  else root.removeAttribute("data-style");
  if (p.mode === "system") root.removeAttribute("data-theme");
  else root.setAttribute("data-theme", p.mode);
  if (p.text === "large") root.setAttribute("data-text", "large");
  else root.removeAttribute("data-text");
  // Static pages carry both wordings of their title; swap only if the tab still shows one of them
  // (an entity sheet sets its own).
  const plainTitle = root.getAttribute("data-title-plain");
  const codexTitle = root.getAttribute("data-title-codex");
  if (plainTitle && codexTitle && (document.title === plainTitle || document.title === codexTitle)) document.title = p.look === "codex" ? codexTitle : plainTitle;
}

export function savePrefs(patch: Partial<Prefs>): Prefs {
  const next = { ...readPrefs(), ...patch };
  apply(next);
  try {
    localStorage.setItem(KEYS.look, next.look);
    localStorage.setItem(KEYS.text, next.text);
    if (next.mode === "system") localStorage.removeItem(KEYS.mode);
    else localStorage.setItem(KEYS.mode, next.mode);
  } catch {
    // Storage off: the choice lasts for this page only.
  }
  window.dispatchEvent(new CustomEvent(EVENT));
  return next;
}

/** The resolved color scheme right now (the OS decides when the mode is "system"). */
export function isDark(p: Prefs = readPrefs()): boolean {
  return p.mode === "dark" || (p.mode === "system" && window.matchMedia("(prefers-color-scheme: dark)").matches);
}

let cached: Prefs | undefined;
function snapshot(): Prefs {
  const now = readPrefs();
  if (!cached || cached.look !== now.look || cached.mode !== now.mode || cached.text !== now.text) cached = now;
  return cached;
}

function subscribe(fn: () => void): () => void {
  const onStorage = (e: StorageEvent) => {
    if (e.key && Object.values(KEYS).includes(e.key as never)) {
      // Another tab changed a preference: re-read storage and apply it here too.
      apply(fromStorage());
      fn();
    }
  };
  window.addEventListener(EVENT, fn);
  window.addEventListener("storage", onStorage);
  return () => {
    window.removeEventListener(EVENT, fn);
    window.removeEventListener("storage", onStorage);
  };
}

function fromStorage(): Prefs {
  const get = (k: string) => {
    try {
      return localStorage.getItem(k);
    } catch {
      return null;
    }
  };
  const mode = get(KEYS.mode);
  return { look: get(KEYS.look) === "codex" ? "codex" : "plain", mode: mode === "light" || mode === "dark" ? mode : "system", text: get(KEYS.text) === "large" ? "large" : "standard" };
}

const SERVER: Prefs = { look: "plain", mode: "system", text: "standard" };

export function usePrefs(): Prefs {
  return useSyncExternalStore(subscribe, snapshot, () => SERVER);
}

export interface Voice {
  look: Look;
  plain: boolean;
  /** A shared word in the current voice: `t("quests")` → "Goals" or "Quest board". */
  t: (key: TermKey) => string;
  /** Pick the plain or the codex wording of a one-off phrase: `v("Add a note", "Scribe a memory")`. */
  v: <P, C = P>(plain: P, codex: C) => P | C;
}

/** The reader's voice (plain by default, or the campaign codex) for wording in islands. */
export function useTerms(): Voice {
  const { look } = usePrefs();
  const t = useCallback((key: TermKey) => term(key, look), [look]);
  const v = useCallback(<P, C = P>(plainText: P, codexText: C): P | C => (look === "codex" ? codexText : plainText), [look]);
  return { look, plain: look === "plain", t, v };
}
