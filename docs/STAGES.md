# Implementation Stages

## Stage 0: Documentation & Repo Contract - Complete
Add `AGENTS.md`, README and architecture docs. Lock AWS S3 and Amazon SES as production targets.

## Stage 1: Monorepo Scaffold - Complete
Replace Vite/Express with npm workspaces, Next.js web app, worker app and domain packages.

## Stage 2: Database & Domain Model - Complete baseline
Move from SQLite invoice-upload models to PostgreSQL `Case`, `InvoiceDocument`, `CaseEvent`, `Communication`, `PaymentPromise` and Auth.js models.

## Stage 3: Invoice Intake - Complete baseline
Implement upload/email intake, review and confirm on the new stack. Store originals through `StorageProvider`, parse through `AiProvider`, and match counterparties inside each organization.

## Stage 4: Temporal Workflow - Complete payment-check loop
Start durable `CaseWorkflow` per confirmed case. Wait for due date, ask the customer if payment arrived, and branch to paid close or overdue collection.

Implemented: deterministic workflow ids, durable `WorkflowCommand` outbox, `signalWithStart`, paid/not-paid wake-up signals, activity leases and time-skipping workflow tests.

## Stage 5: Email Intake & Communication - In progress
Add SES/Mailpit provider paths, outbound payment-check/reminder communication, inbound email parsing, debtor reply classification and communication timeline.

Implemented: payment-check email, raw MIME parsing, trusted SES ingress endpoint, invoice/reply idempotency, thread correlation and AI reply classification. Remaining: actual debtor reminder sequence, signed Reply-To on outbound debtor mail and domain actions for promises/disputes.

## Stage 6: Dashboard & Reporting
Expand dashboard with case list filters, overdue queue, promises, communications and exportable case history.

## Stage 7: Advanced Automation
Add installment rules, voice-call adapter, legal package export, optional Textract and future bank integration.
