# 📡 Activity

## Waiting in the inbox

```dataview
TABLE WITHOUT ID file.link AS Episode, agent AS Agent, kind AS Kind, at AS At
FROM "inbox"
SORT at DESC
```

## Recently changed canon

```dataview
TABLE WITHOUT ID file.link AS Note, type AS Type, updated_by AS By, updated AS Updated
FROM "characters" OR "factions" OR "locations" OR "items" OR "lore" OR "quests" OR "campaigns"
WHERE updated
SORT updated DESC
LIMIT 30
```

## Party

```dataview
TABLE WITHOUT ID file.link AS Agent, lane AS Lane, authority AS Authority, host AS Host
FROM "party"
```
