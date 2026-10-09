import { useTerms } from "../lib/prefs.ts";
import type { Shown } from "../lib/types.ts";
import { Icon } from "./Icon.tsx";

/** A fact value as the human may see it: secrets are a sealed (plain: hidden) box, never the value. */
export function Value({ shown, mono }: { shown: Shown; mono?: boolean }) {
  const { v } = useTerms();
  if (shown.secret)
    return (
      <span className="lock" title={v("Hidden: this value is encrypted in secrets/. Read it with `hippo secrets show` on your machine.", "Encrypted in secrets/. Read it with `hippo secrets show` on your machine.")}>
        <Icon name="lock" size={14} />
        {v("hidden", "sealed")}
      </span>
    );
  return <span className={mono ? "mono" : undefined}>{shown.value ?? "—"}</span>;
}
