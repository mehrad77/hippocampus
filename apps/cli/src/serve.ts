/**
 * The agent a local HTTP MCP connection is bound to: `?agent=`, else `--agent`. A bound caller sees
 * the confidential values its authority covers, so a name that is one of the vault's `humans` is
 * refused: anyone who can reach the port could otherwise read as the human. Without the humans
 * (the config didn't load) no connection is bound.
 */
export function boundAgent(humans: string[] | undefined, param: string | null, fallback?: string): { agent?: string } | { refused: string } {
  const agent = (param ?? fallback)?.trim() || undefined;
  if (!agent) return {};
  if (!humans) return { refused: "the vault's config doesn't load, so this connection can't be bound to an agent" };
  if (humans.some((h) => h.toLowerCase() === agent.toLowerCase())) return { refused: `"${agent}" is a human, not an agent: a connection can't be bound to a human` };
  return { agent };
}
