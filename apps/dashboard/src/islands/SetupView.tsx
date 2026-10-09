import { useResource } from "../lib/cache.ts";
import { href } from "../lib/routes.ts";
import type { SessionInfo, SetupStatus } from "../lib/types.ts";
import { Icon } from "../ui/Icon.tsx";
import { PageGate } from "../ui/PageGate.tsx";
import { SkeletonPanel } from "../ui/Parts.tsx";
import { ErrorCallout } from "./setup/common.tsx";
import { LocalWizard } from "./setup/LocalWizard.tsx";
import { describeError } from "./setup/model.ts";
import { RemoteSetup } from "./setup/RemoteSetup.tsx";

/** Session Zero: the setup wizard on `hippo dashboard`, health and agent tokens on the Worker. */
export default function SetupView() {
  return <PageGate allowSetup>{(session) => <SessionZero session={session} />}</PageGate>;
}

function SessionZero({ session }: { session: SessionInfo }) {
  const kind = session.capabilities.setup;
  const status = useResource<SetupStatus>(kind === "none" ? null : "/setup/status");
  if (kind === "none") return <NoSetup session={session} />;
  if (status.error && !status.data) {
    if (describeError(status.error).unsupported) return <NoSetup session={session} />;
    return (
      <div className="stack sz">
        <header className="page-head">
          <div>
            <div className="page-head__kicker">Session Zero</div>
            <h1>Setup & health</h1>
          </div>
        </header>
        <ErrorCallout error={status.error} onRetry={() => void status.reload()} />
      </div>
    );
  }
  if (!status.data)
    return (
      <div className="stack">
        <SkeletonPanel lines={3} />
        <SkeletonPanel lines={8} />
      </div>
    );
  return status.data.kind === "remote" ? <RemoteSetup session={session} status={status.data} /> : <LocalWizard session={session} status={status.data} />;
}

function NoSetup({ session }: { session: SessionInfo }) {
  return (
    <div className="stack sz">
      <header className="page-head">
        <div>
          <div className="page-head__kicker">Session Zero</div>
          <h1>Setup & health</h1>
        </div>
      </header>
      <div className="panel door sz-nosetup">
        <Icon name="setup" size={40} />
        <h2>Setup happens elsewhere</h2>
        <p>
          {session.mode === "mcp"
            ? "This dashboard reads your vault through an MCP server, so it can't set up the machine or the Worker behind it."
            : "This dashboard can't change setup from where it runs."}
        </p>
        <p className="muted small">
          For the setup wizard, run <code>hippo dashboard</code> on the machine that holds your vault. To manage agent tokens, open the dashboard your Worker serves.
        </p>
        <div className="row sz-center">
          <a className="btn btn--primary" href={href.guide("how-it-works")}>
            <Icon name="guides" /> How it works
          </a>
          <a className="btn" href={href.page("guides")}>
            All guides
          </a>
        </div>
      </div>
    </div>
  );
}
