# ⚖ Disputes

Sources disagree on these facts. Open a dispute, set `ruling:` to the correct value, and the next sleep makes it canon.

```dataview
TABLE WITHOUT ID file.link AS Dispute, entity AS Entity, field AS Field, map(claims, (c) => c.value + " (" + c.by + ")") AS Claims, opened AS Opened
FROM "disputes"
WHERE status = "open"
SORT opened ASC
```

## Resolved

```dataview
TABLE WITHOUT ID file.link AS Dispute, entity AS Entity, field AS Field, ruling AS Ruling, resolved AS Resolved
FROM "disputes"
WHERE status = "resolved"
SORT resolved DESC
LIMIT 20
```
