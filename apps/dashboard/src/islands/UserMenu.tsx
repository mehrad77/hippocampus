import { useEffect, useId, useRef, useState } from "react";
import { useTerms } from "../lib/prefs.ts";
import { href } from "../lib/routes.ts";
import { signOut, useSession } from "../lib/session.ts";
import { Icon } from "../ui/Icon.tsx";

/**
 * Who's signed in (hosted app only): a chip with the GitHub login that opens Account, Admin (for
 * admins) and Sign out. `compact` is the phone topbar's avatar-only version.
 */
export default function UserMenu({ compact }: { compact?: boolean }) {
  const { t } = useTerms();
  const session = useSession();
  const [open, setOpen] = useState(false);
  const [leaving, setLeaving] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const id = useId();

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

  const user = session.data?.user;
  if (!user) return null;
  const admin = !!session.data?.account?.admin;
  const initial = user.login.replace(/[^a-z0-9]/gi, "").charAt(0).toUpperCase() || "?";

  return (
    <div className={`usermenu${compact ? " usermenu--compact" : ""}`} ref={root}>
      <button
        ref={button}
        type="button"
        className="usermenu__button"
        aria-expanded={open}
        aria-controls={id}
        aria-label={compact ? `Signed in as @${user.login}: account menu` : undefined}
        onClick={() => setOpen((o) => !o)}
      >
        <span className="usermenu__avatar" aria-hidden>
          {initial}
        </span>
        {!compact && (
          <>
            <span className="usermenu__who">
              <span className="usermenu__hint">Signed in as</span>
              <span className="usermenu__login">@{user.login}</span>
            </span>
            <Icon name="chevron" size={16} className="usermenu__chev" />
          </>
        )}
      </button>
      <ul className="usermenu__list" id={id} hidden={!open}>
        <li>
          <a href={href.page("setup", "#account")} onClick={() => setOpen(false)}>
            <Icon name="github" size={18} /> Account
          </a>
        </li>
        <li>
          <a href={href.page("setup")} onClick={() => setOpen(false)}>
            <Icon name="setup" size={18} /> {t("setup")}
          </a>
        </li>
        {admin && (
          <li>
            <a href={href.page("admin")}>
              <Icon name="party" size={18} /> {t("admin")}
            </a>
          </li>
        )}
        <li>
          <button
            type="button"
            disabled={leaving}
            onClick={() => {
              setLeaving(true);
              void signOut();
            }}
          >
            <Icon name="logout" size={18} /> {leaving ? "Signing out…" : "Sign out"}
          </button>
        </li>
      </ul>
    </div>
  );
}
