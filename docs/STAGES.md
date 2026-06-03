# Implementation Stages

## Stage 0: Documentation & Repo Contract
Add `AGENTS.md`, README and architecture docs. Lock AWS S3 and Amazon SES as production targets.

## Stage 1: Monorepo Scaffold
Replace Vite/Express with npm workspaces, Next.js web app, worker app and domain packages.

## Stage 2: Database & Domain Model
Move from SQLite invoice-upload models to PostgreSQL `Case`, `InvoiceDocument`, `CaseEvent`, `Communication`, `PaymentPromise` and Auth.js models.

## Stage 3: Invoice Intake
Implement upload/review/confirm on the new stack. Store originals through `StorageProvider`, parse through `AiProvider`.

## Stage 4: Temporal Workflow
Start durable `CaseWorkflow` per confirmed case. Wait for due date and schedule reminders through activities.

## Stage 5: Email Intake & Communication
Add SES inbound/outbound adapters, Mailpit fixtures, debtor reply classification and communication timeline.

## Stage 6: Dashboard & Reporting
Expand dashboard with case list filters, overdue queue, promises, communications and exportable case history.

## Stage 7: Advanced Automation
Add installment rules, voice-call adapter, legal package export, optional Textract and future bank integration.
