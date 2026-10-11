import { useState } from "react";
import { ApiError, postJson } from "../lib/api.ts";
import { invalidate, useResource } from "../lib/cache.ts";
import type { Overview, SessionInfo, VaultUpgrade } from "../lib/types.ts";
import { needsUpgrade, upgradeSummary } from "../lib/upgrade.ts";
import { Icon } from "./Icon.tsx";

/**
 * The hosted app never upgrades a vault's format on its own: while the overview answers
 * VAULT_UPGRADE_NEEDED, the owner gets this banner and its button, then the upgrade's notes.
 */
export function UpgradeBanner({ session }: { session: SessionInfo }) {
  const canUpgrade = !!session.capabilities.upgrade;
  const overview = useResource<Overview>(canUpgrade ? "/overview" : null);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState<string>();
  const [done, setDone] = useState<VaultUpgrade>();

  if (done)
    return (
      <div className="callout callout--ok" role="status">
        <Icon name="check" />
        <div className="stack sz-tight">
          <strong>{upgradeSummary(done)}</strong>
          {done.notes.length > 0 && (
            <ul className="small">
              {done.notes.map((n, i) => (
                <li key={i}>{n}</li>
              ))}
            </ul>
          )}
          <span>
            <button type="button" className="btn btn--sm" onClick={() => setDone(undefined)}>
              Dismiss
            </button>
          </span>
        </div>
      </div>
    );
  if (!canUpgrade || !needsUpgrade(overview.error)) return null;

  const upgrade = async () => {
    setBusy(true);
    setFailed(undefined);
    try {
      const result = await postJson<VaultUpgrade>("/actions/upgrade-vault", {});
      setDone(result);
      // Every page's data was refused until now: fetch it again.
      void invalidate();
    } catch (err) {
      setFailed(err instanceof ApiError ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="callout callout--warn" role="alert">
      <Icon name="warn" />
      <div className="stack sz-tight">
        <strong>This vault uses an older format. Upgrade it?</strong>
        <span className="small">
          The upgrade rewrites what changed in one commit to your repo, which you can review or revert on GitHub. Agents can't use the vault until it's done.
        </span>
        {failed && <span className="field-error small">{failed}</span>}
        <span>
          <button type="button" className="btn btn--primary btn--sm" onClick={() => void upgrade()} disabled={busy}>
            <Icon name="refresh" size={16} /> {busy ? "Upgrading…" : "Upgrade vault"}
          </button>
        </span>
      </div>
    </div>
  );
}
