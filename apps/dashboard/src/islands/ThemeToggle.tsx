import { isDark, savePrefs, usePrefs } from "../lib/prefs.ts";
import { Icon } from "../ui/Icon.tsx";

/** Quick light/dark switch in the nav; the full choices live in Setup & health → Personalization. */
export default function ThemeToggle() {
  const prefs = usePrefs();
  const dark = typeof window !== "undefined" && isDark(prefs);
  const label = prefs.look === "codex" ? (dark ? "Parchment" : "Candlelit") : dark ? "Light mode" : "Dark mode";
  return (
    <button type="button" className="navlink navlink--button" onClick={() => savePrefs({ mode: dark ? "light" : "dark" })} aria-label={`Switch to ${label.toLowerCase()}`}>
      <Icon name={dark ? "sun" : "moon"} />
      {label}
    </button>
  );
}
