import { useEffect, useState } from "react";
import { Icon } from "../ui/Icon.tsx";

type Theme = "parchment" | "candlelit";

function current(): Theme {
  const t = document.documentElement.getAttribute("data-theme");
  if (t === "parchment" || t === "candlelit") return t;
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "candlelit" : "parchment";
}

export default function ThemeToggle() {
  const [theme, setTheme] = useState<Theme>("parchment");
  useEffect(() => setTheme(current()), []);
  const next: Theme = theme === "candlelit" ? "parchment" : "candlelit";
  return (
    <button
      type="button"
      className="navlink navlink--button"
      onClick={() => {
        document.documentElement.setAttribute("data-theme", next);
        try {
          localStorage.setItem("hippo:theme", next);
        } catch {
          // Not persisted; fine for this page.
        }
        setTheme(next);
      }}
      aria-label={`Switch to ${next} theme`}
    >
      <Icon name={theme === "candlelit" ? "sun" : "moon"} />
      {theme === "candlelit" ? "Parchment" : "Candlelit"}
    </button>
  );
}
