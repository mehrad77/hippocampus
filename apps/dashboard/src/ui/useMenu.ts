import { useEffect, useRef, useState } from "react";

/** A popup menu's state: closes on a click outside or Escape (which hands focus back to the button). */
export function useMenu<R extends HTMLElement = HTMLDivElement, B extends HTMLElement = HTMLButtonElement>() {
  const [open, setOpen] = useState(false);
  const root = useRef<R>(null);
  const button = useRef<B>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      setOpen(false);
      button.current?.focus();
    };
    document.addEventListener("pointerdown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);
  return { open, setOpen, root, button };
}
