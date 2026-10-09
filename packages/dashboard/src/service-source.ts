import type { HippoService } from "@hippocampus/core";
import type { DashboardSource, Mode, VaultInfo } from "./source.ts";

export interface ServiceSourceOptions {
  /** The agent-run sleep, where there is one (the hosted app's relay). */
  curator?: DashboardSource["curator"];
}

/**
 * A dashboard over a `HippoService`: a local vault, a GitHub repo, the Worker, or the demo.
 * Every action is the human's: it writes as `config.human`, like an edit in Obsidian.
 */
export function serviceSource(service: HippoService, info: { mode: Mode; vault: VaultInfo }, opts: ServiceSourceOptions = {}): DashboardSource {
  // The human's id only changes when someone edits the config, so one read per source is enough.
  let human: Promise<string> | undefined;
  const whoami = () => (human ??= service.vault().then((v) => v.config.human));
  return {
    async info() {
      const { config } = await service.vault();
      human = Promise.resolve(config.human);
      return { ...info, campaign: config.campaign, human: config.human, actor: { kind: "human", id: config.human } };
    },
    overview: () => service.overview(),
    catalog: () => service.catalog(),
    entity: (ref) => service.entityDetail(ref),
    graph: () => service.graph(),
    chronicle: (month) => service.chronicle(month),
    search: (query, limit) => service.search(query, { limit }),
    rule: (dispute, choice, via) => service.rule(dispute, choice, { via }),
    quest: async (ref, update) => service.updateQuest(await whoami(), ref, update, { asHuman: true }),
    remember: async (input) => service.remember(await whoami(), input, { asHuman: true }),
    addParty: (input, via) => service.addPartyMember(input, { via }),
    async introduction({ agent, decision, ...choice }, via) {
      if (decision === "dismiss") return { decision, agent: (await service.dismissIntroduction(agent, { via })).agent };
      return { decision, agent, path: (await service.approveIntroduction(agent, choice, { via })).path };
    },
    ...(opts.curator ? { curator: opts.curator } : {}),
  };
}
