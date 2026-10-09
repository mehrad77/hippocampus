import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, userInfo } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { slugify } from "@hippocampus/core";

// Nightly `hippo sleep` as a launchd agent (macOS) or a cron line (elsewhere). The job runs this
// same CLI; LLM settings and keys stay in the user env file, which the CLI loads on every run.

export interface SleepJob {
  label: string;
  /** The vault directory, or `github` for a repo used through the API. */
  vault?: string;
  github?: string;
  hour: number;
  minute: number;
  nodePath: string;
  cliPath: string;
  logPath: string;
  /** Set when the user env file lives somewhere other than the default, so the job finds it. */
  configDir?: string;
  /** Published version, pinned when the CLI runs from the npx cache. */
  version?: string;
}

export const scheduleLabel = (campaign: string) => `com.hippocampus.sleep.${slugify(campaign).replace(/[^a-z0-9-]/g, "") || "campaign"}`;

/** How to start this CLI again later: the bundle with node, the source checkout's launcher, or a pinned npx. */
export function programArgs(job: Pick<SleepJob, "nodePath" | "cliPath" | "version">): string[] {
  if (job.cliPath.endsWith(".ts")) return [resolve(dirname(job.cliPath), "../bin/hippo")];
  if (job.cliPath.includes(`${sep}_npx${sep}`)) return ["npx", "-y", `@mehrad77/hippocampus${job.version ? `@${job.version}` : ""}`];
  return [job.nodePath, job.cliPath];
}

function sleepArgs(job: Omit<SleepJob, "label">): string[] {
  const target = job.github ? ["--github", job.github] : ["--vault", job.vault ?? "."];
  return [...programArgs(job), ...target, "sleep"];
}

/** node's own directory first (npx, and node for the launcher), then the usual places for git. */
function pathVar(job: Pick<SleepJob, "nodePath">): string {
  return [...new Set([dirname(job.nodePath), "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin"])].join(":");
}

const xml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const str = (s: string) => `<string>${xml(s)}</string>`;

export function renderSleepPlist(job: SleepJob): string {
  const env: [string, string][] = [["PATH", pathVar(job)]];
  if (job.configDir) env.push(["HIPPO_CONFIG_DIR", job.configDir]);
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<!-- Nightly Hippocampus sleep, installed by \`hippo dashboard\`. LLM settings come from the user env file, never from here. -->
<plist version="1.0">
<dict>
  <key>Label</key>
  ${str(job.label)}
  <key>ProgramArguments</key>
  <array>
${sleepArgs(job)
  .map((a) => `    ${str(a)}`)
  .join("\n")}
  </array>
  <key>EnvironmentVariables</key>
  <dict>
${env.map(([k, v]) => `    <key>${k}</key>\n    ${str(v)}`).join("\n")}
  </dict>
  <key>StartCalendarInterval</key>
  <dict>
    <key>Hour</key>
    <integer>${job.hour}</integer>
    <key>Minute</key>
    <integer>${job.minute}</integer>
  </dict>
  <key>StandardOutPath</key>
  ${str(job.logPath)}
  <key>StandardErrorPath</key>
  ${str(job.logPath)}
</dict>
</plist>
`;
}

const shellQuote = (s: string) => (/^[A-Za-z0-9_\-./:@=+,%]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`);

/** The same job for crontab, where launchd isn't available. */
export function cronLine(job: Omit<SleepJob, "label">): string {
  const env = [`PATH=${pathVar(job)}`, ...(job.configDir ? [`HIPPO_CONFIG_DIR=${job.configDir}`] : [])].map(shellQuote);
  return `${job.minute} ${job.hour} * * * ${[...env, ...sleepArgs(job).map(shellQuote)].join(" ")} >> ${shellQuote(job.logPath)} 2>&1`;
}

/** The next time `hour:minute` comes round on this machine's clock. */
export function nextRun(hour: number, minute: number, now: Date = new Date()): string {
  const d = new Date(now);
  d.setHours(hour, minute, 0, 0);
  if (d.getTime() <= now.getTime()) d.setDate(d.getDate() + 1);
  return d.toISOString();
}

export interface Launchd {
  agentsDir: string;
  domain: string;
  run(args: string[]): Promise<{ code: number; out: string }>;
}

/** The real launchd of the signed-in user. */
export function launchd(): Launchd {
  return {
    agentsDir: join(homedir(), "Library", "LaunchAgents"),
    domain: `gui/${userInfo().uid}`,
    run: (args) =>
      new Promise((done) => {
        execFile("launchctl", args, { timeout: 10_000 }, (err, stdout, stderr) => {
          const code = err ? (typeof (err as { code?: unknown }).code === "number" ? ((err as { code: number }).code) : 1) : 0;
          done({ code, out: `${stdout}${stderr}`.trim() });
        });
      }),
  };
}

export const plistPath = (ld: Launchd, label: string) => join(ld.agentsDir, `${label}.plist`);

export async function installSchedule(job: SleepJob, ld: Launchd = launchd()): Promise<void> {
  const file = plistPath(ld, job.label);
  await mkdir(ld.agentsDir, { recursive: true });
  await mkdir(dirname(job.logPath), { recursive: true, mode: 0o700 });
  await writeFile(file, renderSleepPlist(job), { mode: 0o644 });
  await ld.run(["bootout", `${ld.domain}/${job.label}`]);
  // A bootout can take a moment to settle; bootstrapping right after it sometimes fails once.
  let last = { code: 0, out: "" };
  for (let attempt = 0; attempt < 3; attempt++) {
    last = await ld.run(["bootstrap", ld.domain, file]);
    if (last.code === 0) return;
    await new Promise((r) => setTimeout(r, 400));
  }
  throw new Error(`launchctl bootstrap failed: ${last.out || `exit ${last.code}`}`);
}

export async function removeSchedule(label: string, ld: Launchd = launchd()): Promise<void> {
  await ld.run(["bootout", `${ld.domain}/${label}`]);
  await rm(plistPath(ld, label), { force: true });
}

export async function launchdStatus(label: string, ld: Launchd = launchd()): Promise<{ installed: boolean; loaded: boolean; hour?: number; minute?: number }> {
  const file = plistPath(ld, label);
  if (!existsSync(file)) return { installed: false, loaded: false };
  const text = await readFile(file, "utf8");
  const num = (key: string) => {
    const m = new RegExp(`<key>${key}</key>\\s*<integer>(\\d+)</integer>`).exec(text);
    return m ? Number(m[1]) : undefined;
  };
  const loaded = (await ld.run(["print", `${ld.domain}/${label}`])).code === 0;
  return { installed: true, loaded, hour: num("Hour"), minute: num("Minute") };
}
