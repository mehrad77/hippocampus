import { CONFIG, fixtureStore } from "./vault.ts";
import type { MemoryStore } from "../store.ts";

/**
 * The fixture vault plus what managed memory needs: an inheritable `archetype` type, a `group` type,
 * characters with identity-key, human-only and secret fields, kinds with channels, and small caps.
 */
export const MANAGED_CONFIG = `${CONFIG.replace(
  "character: { folder: characters, description: People }",
  "character: { folder: characters, description: People, fields: { email: { identity_key: true }, stakes: { human_only: true }, pin: { human_only: true, secret: true } } }",
).replace(
  "party: { folder: party, description: Agents, capabilities: [actor] }\n",
  "party: { folder: party, description: Agents, capabilities: [actor] }\n  archetype: { folder: archetypes, description: Roles people play, inheritable: true }\n  group: { folder: groups, description: Groups of people }\n",
)}kinds:
  rollup:
    behaviour: interaction
    text: forbidden
    counts_as_contact: { call: true, visit: true, "*": false }
    data:
      with: { kind: ref, many: true }
      channel: text
curator: { canon_threshold: 2, guidelines_cap: 3, decisions_cap: 2, questions_cap: 2 }
`;

export const LANDLORD = "---\ntype: character\ntitle: The landlord\ntags: [colleague]\nfacts:\n  email: { value: landlord@lisbon.example, status: canon }\n---\n\n## Notes\nMet at the Harbor University open day.\n";

export function managedStore(extra: Record<string, string> = {}): MemoryStore {
  return fixtureStore({ "_hippo/config.yaml": MANAGED_CONFIG, "characters/landlord.md": LANDLORD, "characters/player.md": "---\ntype: character\ntitle: Player\n---\n", ...extra });
}
