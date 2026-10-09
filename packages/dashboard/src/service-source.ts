import type { HippoService } from "@hippocampus/core";
import type { DashboardSource, Mode, VaultInfo } from "./source.ts";

/**
 * A dashboard over a `HippoService`: a local vault, a GitHub repo, the Worker, or the demo.
 * Every action is the human's: it writes as `config.human`, like an edit in Obsidian.
 */
export function serviceSource(service: HippoService, info: { mode: Mode; vault: VaultInfo }): DashboardSource {
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
    quest: async (ref, update) => service.updateQuest(await whoami(), ref, update),
    remember: async (input) => service.remember(await whoami(), input),
    addParty: (input, via) => service.addPartyMember(input, { via }),
  };
}
