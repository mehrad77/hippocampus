import { isDark, savePrefs, usePrefs } from "../lib/prefs.ts";
import { Icon } from "../ui/Icon.tsx";

/** The public pages' look and color switches (the full choices live in Setup → Personalization). No data, no session. */
export default function LookSwitch() {
  const prefs = usePrefs();
  const dark = typeof window !== "undefined" && isDark(prefs);
  const codex = prefs.look === "codex";
  return (
    <span className="pub-switch">
      <button type="button" className="btn btn--ghost btn--sm" aria-pressed={codex} onClick={() => savePrefs({ look: codex ? "plain" : "codex" })} title={codex ? "Switch to the plain look" : "Switch to the campaign codex look"}>
        <Icon name="d20" size={16} /> Codex look
      </button>
      <button type="button" className="btn btn--ghost btn--sm btn--icon" onClick={() => savePrefs({ mode: dark ? "light" : "dark" })} aria-label={dark ? "Switch to light colors" : "Switch to dark colors"}>
        <Icon name={dark ? "sun" : "moon"} size={16} />
      </button>
    </span>
  );
}
