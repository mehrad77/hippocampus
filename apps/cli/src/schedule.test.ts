import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cronLine, installSchedule, launchdStatus, nextRun, programArgs, removeSchedule, renderSleepPlist, scheduleLabel, type Launchd, type SleepJob } from "./schedule.ts";

const job: SleepJob = {
  label: scheduleLabel("Lisbon Arc"),
  vault: "/home/player/vaults/lisbon-arc",
  hour: 3,
  minute: 30,
  nodePath: "/opt/node/bin/node",
  cliPath: "/opt/hippocampus/dist/main.js",
  logPath: "/home/player/.config/hippocampus/logs/sleep.lisbon-arc.log",
};

describe("launchd plist", () => {
  it("runs this CLI's sleep on the vault at the chosen time, without any LLM settings", () => {
    const plist = renderSleepPlist(job);
    expect(plist).toMatchInlineSnapshot(`
      "<?xml version="1.0" encoding="UTF-8"?>
      <!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
      <!-- Nightly Hippocampus sleep, installed by \`hippo dashboard\`. LLM settings come from the user env file, never from here. -->
      <plist version="1.0">
      <dict>
        <key>Label</key>
        <string>com.hippocampus.sleep.lisbon-arc</string>
        <key>ProgramArguments</key>
        <array>
          <string>/opt/node/bin/node</string>
          <string>/opt/hippocampus/dist/main.js</string>
          <string>--vault</string>
          <string>/home/player/vaults/lisbon-arc</string>
          <string>sleep</string>
        </array>
        <key>EnvironmentVariables</key>
        <dict>
          <key>PATH</key>
          <string>/opt/node/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>
        </dict>
        <key>StartCalendarInterval</key>
        <dict>
          <key>Hour</key>
          <integer>3</integer>
          <key>Minute</key>
          <integer>30</integer>
        </dict>
        <key>StandardOutPath</key>
        <string>/home/player/.config/hippocampus/logs/sleep.lisbon-arc.log</string>
        <key>StandardErrorPath</key>
        <string>/home/player/.config/hippocampus/logs/sleep.lisbon-arc.log</string>
      </dict>
      </plist>
      "
    `);
    expect(plist).not.toMatch(/HIPPO_LLM|API_KEY|TOKEN/);
  });

  it("uses --github for a repo, escapes XML, and passes a non-default config dir", () => {
    const plist = renderSleepPlist({ ...job, vault: undefined, github: "player/lisbon-arc#main", configDir: "/home/player/hippo & co" });
    expect(plist).toContain("<string>--github</string>\n    <string>player/lisbon-arc#main</string>");
    expect(plist).toContain("<key>HIPPO_CONFIG_DIR</key>\n    <string>/home/player/hippo &amp; co</string>");
  });

  it("starts the CLI the way it was started: bundle, source launcher, or pinned npx", () => {
    expect(programArgs(job)).toEqual(["/opt/node/bin/node", "/opt/hippocampus/dist/main.js"]);
    expect(programArgs({ ...job, cliPath: "/src/hippocampus/apps/cli/src/main.ts" })).toEqual(["/src/hippocampus/apps/cli/bin/hippo"]);
    expect(programArgs({ ...job, cliPath: "/home/player/.npm/_npx/abc/node_modules/@mehrad77/hippocampus/dist/main.js", version: "0.4.0" })).toEqual(["npx", "-y", "@mehrad77/hippocampus@0.4.0"]);
  });
});

describe("cron and timing", () => {
  it("renders the same job as a crontab line", () => {
    expect(cronLine({ ...job, vault: "/home/player/my vaults/lisbon-arc" })).toBe(
      "30 3 * * * PATH=/opt/node/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin /opt/node/bin/node /opt/hippocampus/dist/main.js --vault '/home/player/my vaults/lisbon-arc' sleep >> /home/player/.config/hippocampus/logs/sleep.lisbon-arc.log 2>&1",
    );
  });

  it("finds the next local run", () => {
    const now = new Date(2026, 9, 9, 16, 0);
    expect(new Date(nextRun(3, 30, now)).getTime()).toBe(new Date(2026, 9, 10, 3, 30).getTime());
    expect(new Date(nextRun(17, 5, now)).getTime()).toBe(new Date(2026, 9, 9, 17, 5).getTime());
  });

  it("labels jobs by campaign", () => {
    expect(scheduleLabel("lisbon-arc")).toBe("com.hippocampus.sleep.lisbon-arc");
    expect(scheduleLabel("Ωμέγα")).toBe("com.hippocampus.sleep.campaign");
  });
});

describe("launchd install", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "hippo-launchd-"));
  });
  afterEach(() => rmSync(tmp, { recursive: true, force: true }));

  it("writes the plist, bootstraps it, reports it, and removes it", async () => {
    const calls: string[] = [];
    let loaded = false;
    const ld: Launchd = {
      agentsDir: join(tmp, "LaunchAgents"),
      domain: "gui/501",
      run: async (args) => {
        calls.push(args.join(" "));
        if (args[0] === "bootstrap") loaded = true;
        if (args[0] === "bootout") loaded = false;
        return { code: args[0] === "print" && !loaded ? 113 : 0, out: "" };
      },
    };
    const local = { ...job, logPath: join(tmp, "logs", "sleep.log") };
    await installSchedule({ ...local, hour: 4, minute: 15 }, ld);
    const file = join(tmp, "LaunchAgents", `${job.label}.plist`);
    expect(readFileSync(file, "utf8")).toContain("<integer>15</integer>");
    expect(existsSync(join(tmp, "logs"))).toBe(true);
    expect(await launchdStatus(job.label, ld)).toEqual({ installed: true, loaded: true, hour: 4, minute: 15 });
    await removeSchedule(job.label, ld);
    expect(existsSync(file)).toBe(false);
    expect(await launchdStatus(job.label, ld)).toEqual({ installed: false, loaded: false });
    expect(calls).toEqual([
      `bootout gui/501/${job.label}`,
      `bootstrap gui/501 ${file}`,
      `print gui/501/${job.label}`,
      `bootout gui/501/${job.label}`,
    ]);
  });
});
