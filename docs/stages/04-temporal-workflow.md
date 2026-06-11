# Stage 4: Temporal Workflow

Goal: move waiting and reminder orchestration into Temporal.

Status: payment-check loop complete. Reminder escalation after `OVERDUE` remains part of Stage 5.

Deliverables:
- `caseWorkflow`.
- Worker process.
- Worker-side starter for confirmed cases without workflow ids.
- Durable `WorkflowCommand` outbox and `signalWithStart` dispatcher.
- Activities for DB event writes, payment-check email, overdue marking and reminder scheduling.
- Paid/not-paid action endpoints linked from the customer payment-check email.

Acceptance criteria:
- Workflow records start event.
- Workflow waits until due date.
- Workflow sends a payment-check email to the customer on the due date.
- Workflow activities verify both case and organization before every case-targeted side effect.
- Payment-check delivery uses a durable idempotency key and atomic send lease across Temporal retries.
- Paid action closes the case as `CLOSED_PAID`.
- Not-paid action marks the case as `OVERDUE`.
- Paid/not-paid transitions enqueue a workflow command in the same DB transaction.
- Workflow remains active after the payment-check email and reacts to a state-change signal.
- Due-date waiting is interruptible by durable commands, so debtor replies and disputes are handled before the timer fires.
- Time-skipping tests cover due-date waiting, paid/overdue branches and organization mismatch.
- Replay tests verify the `case-collection-loop-v1` patch against legacy workflow history.
- `overdue-reminder-loop-guard-v1` prevents a stale `OVERDUE` state from repeatedly executing an already-sent reminder.
- Opening a payment-check link with GET never mutates state; only explicit signed-token POST applies a transition.
- Workflow side effects are activities only.

Rollout note:
- Keep the legacy workflow branch and `caseStateChanged` signal until all pre-patch executions finish or are migrated.
- Then deploy `deprecatePatch("case-collection-loop-v1")`; remove legacy code only in a later deployment after replay verification.
