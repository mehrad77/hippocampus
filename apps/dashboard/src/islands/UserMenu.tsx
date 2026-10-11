import { useId, useState } from "react";
import { useResource } from "../lib/cache.ts";
import { useTerms } from "../lib/prefs.ts";
import { href } from "../lib/routes.ts";
import { signOut, useSession } from "../lib/session.ts";
import { Icon } from "../ui/Icon.tsx";
import { useMenu } from "../ui/useMenu.ts";
import type { HostedVaults } from "../lib/types.ts";
import { VaultItems } from "./VaultSwitcher.tsx";

/**
 * Who's signed in (hosted app only): a chip with the GitHub login that opens Account, Admin (for
 * admins) and Sign out. `compact` is the phone topbar's avatar-only version.
 */
export default function UserMenu({ compact }: { compact?: boolean }) {
  const { t } = useTerms();
  const session = useSession();
  const { open, setOpen, root, button } = useMenu();
  const [leaving, setLeaving] = useState(false);
  const id = useId();
  const hosted = session.data?.capabilities?.setup === "hosted";
  const vaults = useResource<HostedVaults>(hosted && session.data?.user ? "/vaults" : null);

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
        {compact && vaults.data && <VaultItems vaults={vaults.data} onPick={() => setOpen(false)} />}
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
