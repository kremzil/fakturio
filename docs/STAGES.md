# Implementation Stages

## Stage 0: Documentation & Repo Contract - Complete
Add `AGENTS.md`, README and architecture docs. Lock AWS S3 and Amazon SES as production targets.

## Stage 1: Monorepo Scaffold - Complete
Replace Vite/Express with npm workspaces, Next.js web app, worker app and domain packages.

## Stage 2: Database & Domain Model - Complete baseline
Move from SQLite invoice-upload models to PostgreSQL `Case`, `InvoiceDocument`, `CaseEvent`, `Communication`, `PaymentPromise` and Auth.js models.

## Stage 3: Invoice Intake - Complete baseline
Implement upload/email intake, review and confirm on the new stack. Store originals through `StorageProvider`, parse through `AiProvider`, and match counterparties inside each organization.

## Stage 4: Temporal Workflow - Complete durable collection loop baseline
Start durable `CaseWorkflow` per confirmed case. Wait for due date, ask the customer if payment arrived, and branch to paid close or overdue collection.

Implemented: deterministic workflow ids, durable `WorkflowCommand` outbox, `signalWithStart`, reply/payment wake-up signals, concurrent timer/signal waiting, activity leases and time-skipping tests including installment dates.

## Stage 5: Email Intake & Communication - Complete baseline
Add SES/Mailpit provider paths, outbound payment-check/reminder communication, inbound email parsing, debtor reply classification and communication timeline.

Implemented: payment-check email, reminder 1 and reminder 2, signed Reply-To, raw MIME parsing, trusted SES ingress endpoint, attachment storage, invoice/reply idempotency, thread correlation, worker-side AI classification, promise/dispute policy and deterministic template replies.

## Stage 6: Dashboard & Reporting - Operational dashboard baseline complete
Implemented: organization-scoped case queue, status/search filters, attention and closed views, promise/installment/payment-check summaries, timeline, communications, responsive case detail, and audited manual paid/pause/resume/cancel actions.

Remaining: case history export, dedicated dispute reporting and broader operational reporting.

## Stage 7: Advanced Automation - Installment baseline complete
Implemented: standard three-payment plan, explicit acceptance, per-installment checks, broken-plan notices and `CALL_REQUIRED`. Remaining: voice-call adapter, post-reminder-2 escalation, legal package export, optional Textract and future bank integration.
