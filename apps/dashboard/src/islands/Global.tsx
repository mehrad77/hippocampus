import { CommandPalette } from "./CommandPalette.tsx";
import { NavStatus } from "./NavStatus.tsx";
import { ScribeDialog } from "./ScribeDialog.tsx";
import { Toasts } from "./Toasts.tsx";

/** Page-wide pieces every page shares: one island, so they share one React root. */
export default function Global() {
  return (
    <>
      <NavStatus />
      <ScribeDialog />
      <CommandPalette />
      <Toasts />
    </>
  );
}
