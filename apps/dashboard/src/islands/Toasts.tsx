import { useEffect, useState } from "react";
import { on, type Events } from "../lib/events.ts";
import { Icon } from "../ui/Icon.tsx";

type Toast = Events["toast"] & { id: number };

export function Toasts() {
  const [items, setItems] = useState<Toast[]>([]);
  useEffect(
    () =>
      on("toast", (t) => {
        const id = Date.now() + Math.random();
        setItems((xs) => [...xs.slice(-3), { ...t, id }]);
        window.setTimeout(() => setItems((xs) => xs.filter((x) => x.id !== id)), t.kind === "error" ? 9000 : 4500);
      }),
    [],
  );
  return (
    <div className="toasts" role="status" aria-live="polite">
      {items.map((t) => (
        <div key={t.id} className={`toast toast--${t.kind ?? "info"}`}>
          <Icon name={t.kind === "error" ? "warn" : t.kind === "ok" ? "check" : "sparkle"} />
          <div>{t.message}</div>
        </div>
      ))}
    </div>
  );
}
