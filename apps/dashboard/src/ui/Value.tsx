import type { Shown } from "../lib/types.ts";
import { Icon } from "./Icon.tsx";

/** A fact value as the human may see it: secrets are a sealed box, never the value. */
export function Value({ shown, mono }: { shown: Shown; mono?: boolean }) {
  if (shown.secret)
    return (
      <span className="lock" title="Encrypted in secrets/. Read it with `hippo secrets show` on your machine.">
        <Icon name="lock" size={14} />
        sealed
      </span>
    );
  return <span className={mono ? "mono" : undefined}>{shown.value ?? "—"}</span>;
}
