# 🗺 Quest board

> Requires the Dataview community plugin.

## Active quests

```dataview
TABLE WITHOUT ID file.link AS Quest, status AS Status, owner AS Owner, deadline AS Due
FROM "quests"
WHERE status != "done" AND status != "failed"
SORT deadline ASC
```

## Open objectives

```dataview
TASK
FROM "quests"
WHERE !completed
GROUP BY file.link
```

## Recently completed

```dataview
TABLE WITHOUT ID file.link AS Quest, updated AS Updated
FROM "quests"
WHERE status = "done"
SORT updated DESC
LIMIT 10
```
