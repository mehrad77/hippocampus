---
folder: courses
label: course
codex_label: course
template: _hippo/templates/course.md
fields:
  code:
    identity_key: true
    description: The course code (HU-ECO-101); identifies the course.
  credits:
    kind: number
    description: Credits (ECTS or the school's own).
  term:
    kind: text
    description: The term it runs in (2026-fall).
  instructor:
    kind: ref
    target: [character]
    description: Who teaches it.
---
A course the human takes. The timetable is goals: a weekly lecture or lab is a goal with `repeat: { every: 1w }` and `due` on the next session, so the briefing shows what's on this week. Readings and deadlines are `assignment` notes with the course as `counterparty`.

## Is
- Introduction to Economics at Harbor University, 6 credits, fall term
- The Portuguese course at the language center

## Is not
- One piece of coursework (that's an `assignment`)
- The university or the department (that's a `faction`)
