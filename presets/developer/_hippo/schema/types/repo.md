---
folder: repos
label: repository
codex_label: repository
template: _hippo/templates/repo.md
fields:
  url:
    identity_key: true
    description: Where it lives (https://git.example.org/team/repo); identifies the repo.
  default_branch:
    kind: text
    description: The branch changes land on.
  language:
    kind: text
    many: true
    description: Main languages.
---
A code repository. Architecture decisions are `decision` memories about the repo, with `data.why`, `data.alternatives` and `data.revisit`: the repo's decision log is its ADR record. Team conventions (commit style, review rules, how to run the tests) are guidelines on the repo.

## Is
- The Harbor University course-planner app
- A shared library of form validators

## Is not
- What the code runs as in production (that's a `service`)
- A how-to for working on it (that's `lore`, linked as the service's runbook)
