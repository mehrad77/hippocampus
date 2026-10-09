import { useId } from "react";
import { savePrefs, usePrefs, type Mode, type TextSize } from "../lib/prefs.ts";
import type { Look } from "../lib/terms.ts";
import { Icon } from "./Icon.tsx";
import { Panel } from "./Parts.tsx";

const LOOKS: { value: Look; name: string; blurb: string }[] = [
  { value: "plain", name: "Plain", blurb: "IBM Carbon design: clean, high contrast and easy to read, with everyday names (Home, Goals, Disputes, Inbox)." },
  { value: "codex", name: "Campaign codex", blurb: "The tabletop look: parchment and candlelight, the Tavern, the Quest board, the Council." },
];

const MODES: { value: Mode; label: string; icon: "eye" | "sun" | "moon" }[] = [
  { value: "system", label: "Match my device", icon: "eye" },
  { value: "light", label: "Light", icon: "sun" },
  { value: "dark", label: "Dark", icon: "moon" },
];

const SIZES: { value: TextSize; label: string }[] = [
  { value: "standard", label: "Standard" },
  { value: "large", label: "Large" },
];

/** How this browser shows the dashboard. Applies at once and is remembered here (not in the vault). */
export function Personalization() {
  const prefs = usePrefs();
  const id = useId();
  return (
    <Panel title="Personalization" icon="sparkle" id="personalization" aside="Saved in this browser" className="personalize">
      <div className="personalize__grid">
        <fieldset className="personalize__group personalize__group--looks">
          <legend className="label">Theme</legend>
          <div className="look-cards" role="radiogroup" aria-label="Theme">
            {LOOKS.map((l) => (
              <label key={l.value} className={`look-card look-card--${l.value}`} data-checked={prefs.look === l.value ? "" : undefined}>
                <input type="radio" name={`${id}-look`} value={l.value} checked={prefs.look === l.value} onChange={() => savePrefs({ look: l.value })} />
                <span className="look-card__preview" aria-hidden>
                  <span className="look-card__bar" />
                  <span className="look-card__line" />
                  <span className="look-card__line look-card__line--short" />
                  <span className="look-card__chip" />
                </span>
                <span className="look-card__text">
                  <strong>
                    {l.name}
                    {l.value === "plain" && <span className="look-card__default">default</span>}
                  </strong>
                  <span className="small">{l.blurb}</span>
                </span>
                {prefs.look === l.value && <Icon name="check" className="look-card__tick" />}
              </label>
            ))}
          </div>
        </fieldset>

        <fieldset className="personalize__group">
          <legend className="label">Colors</legend>
          <div className="segmented" role="radiogroup" aria-label="Colors">
            {MODES.map((m) => (
              <label key={m.value} data-checked={prefs.mode === m.value ? "" : undefined}>
                <input type="radio" name={`${id}-mode`} value={m.value} checked={prefs.mode === m.value} onChange={() => savePrefs({ mode: m.value })} />
                <Icon name={m.icon} size={16} />
                {m.label}
              </label>
            ))}
          </div>
        </fieldset>

        <fieldset className="personalize__group">
          <legend className="label">Text size</legend>
          <div className="segmented" role="radiogroup" aria-label="Text size">
            {SIZES.map((s) => (
              <label key={s.value} data-checked={prefs.text === s.value ? "" : undefined}>
                <input type="radio" name={`${id}-text`} value={s.value} checked={prefs.text === s.value} onChange={() => savePrefs({ text: s.value })} />
                <span className={s.value === "large" ? "segmented__big" : undefined}>Aa</span>
                {s.label}
              </label>
            ))}
          </div>
        </fieldset>
      </div>
    </Panel>
  );
}
