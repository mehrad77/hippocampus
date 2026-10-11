# Memory vault

This is a **Hippocampus** memory vault: a shared, curated memory for a person's AI agents. Open it in [Obsidian](https://obsidian.md) as a vault. (Hippocampus started out as a TTRPG campaign wiki, and some names still show it: agents are the "party", and a dashboard can call goals "quests".)

- **Agents:** read [AGENTS.md](AGENTS.md) and [HANDBOOK.md](HANDBOOK.md) first. Use the Hippocampus MCP tools; don't edit files directly.
- **Humans:** edit anything. Your edits outrank every agent. The curator only rewrites the `%% hippo:… %%` regions and the `facts`/`relations` properties.
- **Curator rules:** [_hippo/curator.md](_hippo/curator.md) holds your house rules for consolidation. Edit them in plain words.
- **Types and kinds:** `_hippo/schema/types/` has one note per entity type (its folder, fields and what belongs there), `_hippo/schema/kinds/` one per kind of memory. Presets add more (`hippo preset add <name>`; `presets:` in the config lists those added).
- **Dashboards:** `_hippo/dashboards/` (install the Dataview plugin).
- **Morning review:** `_hippo/review.md` lists disputes, rumors, stale facts, and failed episodes.

| Folder | Holds |
| --- | --- |
| `characters/` `factions/` `locations/` `items/` `lore/` | People, organizations, places, things and know-how (semantic memory) |
| `goals/` `arcs/` | Things to get done (status, owner, progress, due dates, objectives), and the longer stretches they belong to |
| `party/` | The agents: lanes and authority |
| `chronicle/` | Day-by-day log of consolidated episodes (episodic memory) |
| `inbox/` | New, unconsolidated episodes |
| `disputes/` | Contradictions and proposals waiting for a human ruling |
| `secrets/` | age-encrypted secret values |
