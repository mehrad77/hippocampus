// A tiny cross-island event bus: Astro islands are separate React roots, so they talk through window events.

export interface Events {
  "scribe:open": { about?: string[]; kind?: string };
  "palette:open": Record<string, never>;
  toast: { message: string; kind?: "ok" | "error" | "info" };
  "vault:changed": { path?: string };
}

export function emit<K extends keyof Events>(name: K, detail: Events[K]): void {
  window.dispatchEvent(new CustomEvent(`hippo:${name}`, { detail }));
}

export function on<K extends keyof Events>(name: K, fn: (detail: Events[K]) => void): () => void {
  const handler = (e: Event) => fn((e as CustomEvent<Events[K]>).detail);
  window.addEventListener(`hippo:${name}`, handler);
  return () => window.removeEventListener(`hippo:${name}`, handler);
}

export function toast(message: string, kind: Events["toast"]["kind"] = "info"): void {
  emit("toast", { message, kind });
}
