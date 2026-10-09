import { spawn } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import { CONFIG_PATH } from "@hippocampus/core";
import type { SetupPort } from "@hippocampus/dashboard";
import { demoSetup } from "@hippocampus/dashboard/demo";
import type { EnvOrigins } from "../env-file.ts";
import { assetRoot, cliVersion, configDir, dashboardRoot, expandHome } from "../paths.ts";
import { localSetup } from "./local-setup.ts";
import { DashboardRuntime, type VaultTarget } from "./runtime.ts";
import { launchToken, startDashboardServer } from "./server.ts";

export interface DashboardCommandOptions {
  port: string;
  open: boolean;
  demo?: boolean;
  mcp?: string;
  token?: string;
  /** Global options: the vault directory and `--github` (both may come from the env). */
  vault: string;
  github?: string;
  index: boolean;
  origins: EnvOrigins;
  log: (msg: string) => void;
}

/** demo → --mcp → --github / HIPPO_GITHUB_REPO → a vault directory → Session Zero (no vault yet). */
function startTarget(o: DashboardCommandOptions): VaultTarget | undefined {
  if (o.demo) return { kind: "demo" };
  if (o.mcp) {
    const url = new URL(o.mcp);
    const loopback = ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
    if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) throw new Error("--mcp needs an https:// URL (or http://127.0.0.1 for a local server)");
    return { kind: "mcp", url: o.mcp, token: o.token ?? process.env.HIPPO_MCP_TOKEN };
  }
  if (o.github) return { kind: "github", repo: o.github };
  const dir = resolve(expandHome(o.vault));
  return existsSync(join(dir, CONFIG_PATH)) ? { kind: "dir", dir } : undefined;
}

export function openBrowser(url: string): void {
  const [cmd, args] = process.platform === "darwin" ? ["open", [url]] : process.platform === "win32" ? ["cmd", ["/c", "start", "", url]] : ["xdg-open", [url]];
  try {
    const child = spawn(cmd as string, args as string[], { stdio: "ignore", detached: true });
    child.on("error", () => {});
    child.unref();
  } catch {
    // No browser here (ssh, CI): the printed link is enough.
  }
}

export async function runDashboard(o: DashboardCommandOptions): Promise<void> {
  const port = Number(o.port);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error(`--port ${o.port} is not a port number`);
  const assets = assetRoot();
  const runtime = new DashboardRuntime({ env: process.env, index: o.index, assets, log: o.log });

  const target = startTarget(o);
  let setup: SetupPort;
  if (target?.kind === "demo") {
    const demo = await runtime.open(target);
    const ov = await demo.service!.overview();
    setup = demoSetup({ agents: ov.party.map((p) => ({ id: p.slug, title: p.title, lastSeen: p.lastSeen })), unknownAgents: ov.attention.unknownAgents });
  } else {
    const cliPath = process.argv[1] ? realpathSync(process.argv[1]) : join(assets, "dist", "main.js");
    setup = localSetup({ runtime, origins: o.origins, assets, cli: { nodePath: process.execPath, cliPath, version: cliVersion() } });
    if (target) {
      try {
        await runtime.open(target);
      } catch (err) {
        // Still start: Session Zero can fix a wrong path, token or URL.
        o.log(`⚠ ${err instanceof Error ? err.message : String(err)}\n  Starting in setup mode instead.`);
      }
    }
  }

  const token = await launchToken(join(configDir(), "dashboard-token"));
  const root = dashboardRoot();
  const srv = await startDashboardServer({ port, token, runtime, setup, staticRoot: root });
  const a = runtime.vault;
  const what =
    a?.mode === "demo"
      ? "demo"
      : a
        ? `${a.mode} · ${a.vault.dir ?? (a.vault.repo ? `${a.vault.repo}#${a.vault.branch}` : a.vault.url)}`
        : "setup: no vault yet";
  o.log(`✦ Hippocampus dashboard (${what}) on ${srv.origin}${srv.port !== port && port !== 0 ? ` (port ${port} was taken)` : ""}`);
  if (a?.mode === "demo") o.log("  This is the fictional example campaign (seeds/example-relocation), in memory: nothing you do is saved.");
  if (!root) o.log("  ⚠ The UI isn't built: run `pnpm --filter @hippocampus/dashboard-ui build` (the API still works).");
  o.log(`\n  Open: ${srv.signInUrl}\n\n  That link signs a browser in; keep it to yourself. Ctrl-C stops the dashboard.`);
  if (o.open) openBrowser(srv.signInUrl);

  const stop = () => {
    void Promise.allSettled([srv.close(), runtime.close()]).then(() => process.exit(0));
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
}
