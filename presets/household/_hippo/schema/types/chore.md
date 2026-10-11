---
folder: chores
extends: goal
label: chore
codex_label: chore
template: _hippo/templates/chore.md
---
A recurring job around the home. Give it `repeat: { every: 1w }` (or `2w`, `1m`): once done, it comes back with the next due date.

## Is
- Take out the recycling, every week
- Descale the kettle, every month

## Is not
- Something paid (that's a `bill`)
- A one-off repair (that's a `goal` or a `task`)
