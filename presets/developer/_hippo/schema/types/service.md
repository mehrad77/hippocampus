---
folder: services
label: service
codex_label: service
template: _hippo/templates/service.md
fields:
  owner:
    kind: ref
    target: [character, faction]
    description: Who answers for it.
  runbook:
    kind: ref
    target: [lore]
    description: The lore note that says how to operate and fix it.
  url:
    kind: text
    description: Where it runs.
---
Something running that people or other services use: an API, a job, a database. Link it to the repo it's built from (`part_of`) and to what it needs (`depends_on`; the other side reads `used_by`).

## Is
- The enrollment API, built from the course-planner repo
- The nightly export job

## Is not
- The code itself (that's a `repo`)
- One outage (that's an `incident` memory about the service)
