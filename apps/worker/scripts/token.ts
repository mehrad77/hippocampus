// Mint or revoke an agent's bearer token for the Worker. Tokens are shown once; KV keeps only their hash.
//   pnpm --filter @hippocampus/worker agent-token create <agent> [--scopes read,remember,quest] [--remote]
//   pnpm --filter @hippocampus/worker agent-token revoke <token> [--remote]
import { execFileSync } from "node:child_process";
import { SCOPES, type Scope } from "@hippocampus/mcp";
import { AGENT_ID, hashToken, newToken, type Grant } from "../src/auth.ts";

const args = process.argv.slice(2);
const flag = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args.splice(i, 2)[1] : undefined;
};
const remote = args.includes("--remote") ? (args.splice(args.indexOf("--remote"), 1), true) : false;
const scopes = (flag("--scopes") ?? "read,remember").split(",").map((s) => s.trim()) as Scope[];
const [command, subject] = args;

const wrangler = (...rest: string[]) =>
  execFileSync("pnpm", ["exec", "wrangler", "kv", "key", ...rest, "--binding", "TOKENS", remote ? "--remote" : "--local"], { stdio: ["ignore", "ignore", "inherit"] });

if (command === "create" && subject) {
  const unknown = scopes.filter((s) => !(SCOPES as readonly string[]).includes(s));
  if (unknown.length) throw new Error(`unknown scopes ${unknown.join(", ")}; choose from ${SCOPES.join(", ")}`);
  const agent = subject.toLowerCase();
  if (!AGENT_ID.test(agent)) throw new Error(`"${subject}" isn't an agent id: use lowercase letters, digits and dashes, like home-finder`);
  const token = newToken();
  const grant: Grant = { agent, scopes, created: new Date().toISOString() };
  // The grant goes in as metadata too, so the dashboard lists every token in one call.
  wrangler("put", await hashToken(token), JSON.stringify(grant), "--metadata", JSON.stringify(grant));
  process.stderr.write(`✓ token for ${grant.agent} (${scopes.join(", ")}) stored ${remote ? "remotely" : "locally"}. It is shown only once:\n`);
  console.log(token);
} else if (command === "revoke" && subject) {
  wrangler("delete", await hashToken(subject));
  process.stderr.write("✓ revoked\n");
} else {
  process.stderr.write("usage: agent-token create <agent> [--scopes read,remember,quest] [--remote] | agent-token revoke <token> [--remote]\n");
  process.exitCode = 1;
}
