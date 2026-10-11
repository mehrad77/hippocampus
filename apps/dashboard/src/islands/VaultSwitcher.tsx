import { useId } from "react";
import { useResource } from "../lib/cache.ts";
import { useTerms } from "../lib/prefs.ts";
import { href } from "../lib/routes.ts";
import { useSession } from "../lib/session.ts";
import type { HostedVaults } from "../lib/types.ts";
import { switchVault } from "../lib/vault.ts";
import { Icon } from "../ui/Icon.tsx";
import { useMenu } from "../ui/useMenu.ts";

/** A vault's short name: its repo, without the owner. */
const repoName = (fullName: string) => fullName.split("/").pop() ?? fullName;

/**
 * Which vault this tab shows, and the others to switch to (hosted app only). Sits under the brand
 * in the rail; on phones the account menu lists the same vaults.
 */
export default function VaultSwitcher() {
  const { v } = useTerms();
  const session = useSession();
  const hosted = session.data?.capabilities?.setup === "hosted" && !!session.data.user;
  const vaults = useResource<HostedVaults>(hosted ? "/vaults" : null);
  const { open, setOpen, root, button } = useMenu();
  const id = useId();
  const list = vaults.data;
  if (!list?.vaults.length) return null;
  const current = list.vaults.find((x) => x.id === list.current) ?? list.vaults[0]!;
  return (
    <div className="usermenu vaultmenu" ref={root}>
      <button ref={button} type="button" className="usermenu__button" aria-expanded={open} aria-controls={id} onClick={() => setOpen((o) => !o)}>
        <Icon name={current.provider === "gitlab" ? "cloud" : "github"} size={18} />
        <span className="usermenu__who">
          <span className="usermenu__hint">{v("Vault", "Campaign")}</span>
          <span className="usermenu__login" title={current.fullName}>
            {repoName(current.fullName)}
          </span>
        </span>
        <Icon name="chevron" size={16} className="usermenu__chev" />
      </button>
      <ul className="usermenu__list" id={id} hidden={!open}>
        <VaultItems vaults={list} onPick={() => setOpen(false)} />
      </ul>
    </div>
  );
}

/** The vaults as menu items, the current one marked, then adding and managing them. */
export function VaultItems({ vaults, onPick }: { vaults: HostedVaults; onPick: () => void }) {
  const { v } = useTerms();
  const current = vaults.current ?? vaults.vaults[0]?.id;
  return (
    <>
      <li className="usermenu__head" aria-hidden>
        {v("Your vaults", "Your campaigns")}
      </li>
      {vaults.vaults.map((x) => (
        <li key={x.id}>
          <button
            type="button"
            aria-current={x.id === current ? "true" : undefined}
            onClick={() => {
              onPick();
              if (x.id !== current) switchVault(x.id);
            }}
          >
            <Icon name={x.id === current ? "check" : x.provider === "gitlab" ? "cloud" : "github"} size={18} />
            <span className="usermenu__item">
              <span>{repoName(x.fullName)}</span>
              {x.status !== "ready" && <span className="small muted"> · {x.status === "bootstrapping" ? "setting up" : "disconnected"}</span>}
            </span>
          </button>
        </li>
      ))}
      {vaults.vaults.length < vaults.limit && (
        <li>
          <a href={`${href.page("setup")}?add#create`} onClick={onPick}>
            <Icon name="plus" size={18} /> {v("Add a vault", "Open another campaign")}
          </a>
        </li>
      )}
      <li>
        <a href={href.page("setup", "#vaults")} onClick={onPick}>
          <Icon name="setup" size={18} /> {v("Manage vaults", "Manage campaigns")}
        </a>
      </li>
      <li className="usermenu__sep" aria-hidden />
    </>
  );
}
