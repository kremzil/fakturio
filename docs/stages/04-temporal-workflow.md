# Stage 4: Temporal Workflow

Goal: move waiting and reminder orchestration into Temporal.

Deliverables:
- `caseWorkflow`.
- Worker process.
- Activities for DB event writes, overdue marking and reminder scheduling.

Acceptance criteria:
- Workflow records start event.
- Workflow waits until due date.
- Workflow side effects are activities only.
