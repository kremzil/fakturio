# Implementation Stages

## Stage 0: Documentation & Repo Contract - Complete
Add `AGENTS.md`, README and architecture docs. Lock AWS S3 and Amazon SES as production targets.

## Stage 1: Monorepo Scaffold - Complete
Replace Vite/Express with npm workspaces, Next.js web app, worker app and domain packages.

## Stage 2: Database & Domain Model - Complete baseline
Move from SQLite invoice-upload models to PostgreSQL `Case`, `InvoiceDocument`, `CaseEvent`, `Communication`, `PaymentPromise` and Auth.js models.

## Stage 3: Invoice Intake - Complete baseline
Implement upload/email intake, review and confirm on the new stack. Store originals through `StorageProvider`, parse through `AiProvider`, and match counterparties inside each organization.

Implemented: multi-attachment email guard with AI triage, strict auto-split threshold, supporting-document history, customer clarification loop and deferred parsing from stored attachments.

## Stage 4: Temporal Workflow - Complete durable collection loop baseline
Start durable `CaseWorkflow` per confirmed case. Wait for due date, ask the customer if payment arrived, and branch to paid close or overdue collection.

Implemented: deterministic workflow ids, durable `WorkflowCommand` outbox, `signalWithStart`, reply/payment wake-up signals, concurrent timer/signal waiting, activity leases, guard rails against reminder/scheduler hot loops and time-skipping tests including installment dates.

Remaining: define a history-size/`continueAsNew` policy before production volume and remove legacy workflow branches only through a replay-safe patch deprecation rollout.

## Stage 5: Email Intake & Communication - Complete baseline
Add SES/Mailpit provider paths, outbound payment-check/reminder communication, inbound email parsing, debtor reply classification and communication timeline.

Implemented: payment-check email, reminder 1 and reminder 2, signed Reply-To, raw MIME parsing, trusted SES ingress endpoint, attachment storage, invoice/reply idempotency, thread correlation, worker-side AI classification, promise/dispute policy and deterministic template replies.

Customer email assistant implemented: missing-field clarification, case status/history answers, notes/contact patches, email-start for valid reviewed cases, customer-authorized standard three-payment installment proposal, and customer-authorized additional debtor messages. Non-standard payment proposals can be forwarded as debtor messages, but they do not create tracked installment schedules until a dedicated policy is implemented. Payment receipt, cancellation, pause/resume and legal actions still require dashboard/manual confirmation.

Remaining: product decision and implementation for explicit partial-payment handling. In v1, any debtor-mentioned partial or different amount pauses automation for manual review. Also replace active reply-classification lease retries with a quieter wait/no-op path so concurrent workers do not produce noisy transient errors.

## Stage 6: Dashboard & Reporting - Operational dashboard baseline complete
Implemented: organization-scoped case queue, status/search filters, attention and closed views, promise/installment/payment-check summaries, timeline, communications, responsive case detail, and audited manual paid/pause/resume/cancel actions.

Remaining: case history export, dedicated dispute reporting and broader operational reporting.

## Stage 7: Advanced Automation - Installment baseline complete
Implemented: standard three-payment plan, explicit acceptance, per-installment checks, broken-plan notices and `CALL_REQUIRED`.

Remaining: declarative collection cadence, voice-call adapter, post-reminder-2 escalation, activation of reserved states (`PAYMENT_REQUEST_SENT`, `CALL_SCHEDULED`, `CALL_COMPLETED`, `FINAL_NOTICE_SENT`, `READY_FOR_LEGAL_ACTION`), legal package export, optional Textract and future bank integration.
