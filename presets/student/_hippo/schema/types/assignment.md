---
folder: assignments
extends: goal
label: assignment
codex_label: trial
template: _hippo/templates/assignment.md
statuses:
  assigned: active
  started: active
  submitted: done
  graded: done
  missed: failed
fields:
  weight:
    kind: number
    description: Share of the final grade, in percent.
  grade:
    kind: text
    description: The grade it got.
---
Coursework with a deadline: an essay, a problem set, an exam to sit. Its course is the `counterparty`. A weekly problem set is one assignment with `repeat: { every: 1w }`: once submitted, it comes back with next week's due date.

## Is
- Problem set for Introduction to Economics, due every Monday
- Final essay, 30% of the grade, due 2026-12-15

## Is not
- The course itself (that's a `course`)
- What was said in class (that's a `lecture` memory)
