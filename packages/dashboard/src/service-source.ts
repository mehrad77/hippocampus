import { VaultError, type HippoService, type Vault } from "@hippocampus/core";
import type { DashboardSource, Mode, VaultInfo } from "./source.ts";

export interface ServiceSourceOptions {
  /** Which of the vault's humans the dashboard acts as (default: the primary human). */
  human?: string;
  /** The agent-run sleep, where there is one (the hosted app's relay). */
  curator?: DashboardSource["curator"];
}

/** The dashboard reads as the vault's human, who sees their own confidential values. */
export const HUMAN_READ = { human: true } as const;

/**
 * A dashboard over a `HippoService`: a local vault, a GitHub repo, the Worker, or the demo.
 * Every action is a human's (`opts.human`, else the primary one), like an edit in Obsidian.
 */
export function serviceSource(service: HippoService, info: { mode: Mode; vault: VaultInfo }, opts: ServiceSourceOptions = {}): DashboardSource {
  // The humans only change when someone edits the config, so one read per source is enough.
  let human: Promise<string> | undefined;
  const pick = (vault: Vault) => {
    if (!opts.human) return vault.config.human;
    const h = vault.human(opts.human);
    if (!h) throw new VaultError(`"${opts.human}" is not one of this vault's humans (${vault.config.humans.map((x) => x.id).join(", ")})`);
    return h.id;
  };
  const whoami = () => (human ??= service.vault().then(pick));
  return {
    async info() {
      const vault = await service.vault();
      const { config } = vault;
      const id = pick(vault);
      human = Promise.resolve(id);
      return {
        ...info,
        name: config.name,
        campaign: config.campaign,
        human: config.human,
        humans: config.humans.map((h) => h.id),
        actor: { kind: "human", id },
      };
    },
    overview: () => service.overview(HUMAN_READ),
    catalog: () => service.catalog(HUMAN_READ),
    entity: (ref) => service.entityDetail(ref, HUMAN_READ),
    graph: () => service.graph(HUMAN_READ),
    chronicle: (month) => service.chronicle(month, HUMAN_READ),
    search: (query, limit) => service.search(query, { limit, ...HUMAN_READ }),
    rule: async (dispute, choice, via) => service.rule(dispute, choice, { via, as: await whoami() }),
    goal: async (ref, update) => {
      const id = await whoami();
      return service.updateGoal(id, ref, update, { asHuman: id });
    },
    quest: async (ref, update) => {
      const id = await whoami();
      return service.updateQuest(id, ref, update, { asHuman: id });
    },
    proposal: async (ref, choice, via) => service.decideProposal(ref, choice, { as: await whoami(), via }),
    retract: async (ref, field, scope, via) => service.retract(ref, field, { scope, as: await whoami(), via }),
    remember: async (input) => {
      const id = await whoami();
      return service.remember(id, input, { asHuman: id });
    },
    addParty: (input, via) => service.addPartyMember(input, { via }),
    addDomains: async (ids, via) => ({ added: (await service.addDomains(ids, { via })).added }),
    setSecretsRecipient: async (recipient, via, replace) => ({ changed: (await service.setSecretsRecipient(recipient, { via, replace })).changed }),
    secretFiles: () => service.secretFiles(),
    rotateSecrets: async (recipient, files, via) => ({ rotated: (await service.rotateSecrets(recipient, files, { via })).rotated }),
    setAuthority: (agent, domains, via) => service.setAuthority(agent, domains, { via }),
    async introduction({ agent, decision, ...choice }, via) {
      if (decision === "dismiss") return { decision, agent: (await service.dismissIntroduction(agent, { via })).agent };
      return { decision, agent, path: (await service.approveIntroduction(agent, choice, { via })).path };
    },
    ...(opts.curator ? { curator: opts.curator } : {}),
  };
}
