# 🎯 Goals

> Requires the Dataview community plugin.

## Active goals

```dataview
TABLE WITHOUT ID file.link AS Goal, status AS Status, owner AS Owner, choice(progress, progress.done + "/" + progress.total, "") AS Progress, due AS Due
FROM "goals"
WHERE status != "done" AND status != "failed"
SORT due ASC
```

## Open objectives

```dataview
TASK
FROM "goals"
WHERE !completed
GROUP BY file.link
```

## Recently completed

```dataview
TABLE WITHOUT ID file.link AS Goal, updated AS Updated
FROM "goals"
WHERE status = "done"
SORT updated DESC
LIMIT 10
```
