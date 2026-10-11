---
behaviour: observation
data:
  service:
    kind: ref
    target: [service]
    description: The service that broke.
  severity:
    kind: enum
    values: [low, medium, high, critical]
    description: How bad it was for the people using it.
---
Something broke or degraded: what happened, what it hit, and what fixed it. A lasting change that came out of it is a `decision`; a rule for next time is a guideline on the service.

## Is
- The enrollment API returned errors for 20 minutes after the deploy; rolled back
- The nightly export ran twice and sent duplicate emails

## Is not
- A planned change (that's a `decision` or a `task`)
- A bug nobody has hit yet (that's a `task` or an `observation`)
