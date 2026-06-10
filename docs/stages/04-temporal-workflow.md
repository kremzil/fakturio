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
- Time-skipping tests cover due-date waiting, paid/overdue branches and organization mismatch.
- Opening a payment-check link with GET never mutates state; only explicit signed-token POST applies a transition.
- Workflow side effects are activities only.
