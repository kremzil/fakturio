# Implementation Stages

## Stage 0: Documentation & Repo Contract
Add `AGENTS.md`, README and architecture docs. Lock AWS S3 and Amazon SES as production targets.

## Stage 1: Monorepo Scaffold
Replace Vite/Express with npm workspaces, Next.js web app, worker app and domain packages.

## Stage 2: Database & Domain Model
Move from SQLite invoice-upload models to PostgreSQL `Case`, `InvoiceDocument`, `CaseEvent`, `Communication`, `PaymentPromise` and Auth.js models.

## Stage 3: Invoice Intake
Implement upload/email intake, review and confirm on the new stack. Store originals through `StorageProvider`, parse through `AiProvider`, and match counterparties inside each organization.

## Stage 4: Temporal Workflow
Start durable `CaseWorkflow` per confirmed case. Wait for due date, ask the customer if payment arrived, and branch to paid close or overdue collection.

## Stage 5: Email Intake & Communication
Add SES/Mailpit provider paths, outbound payment-check/reminder communication, inbound email parsing, debtor reply classification and communication timeline.

## Stage 6: Dashboard & Reporting
Expand dashboard with case list filters, overdue queue, promises, communications and exportable case history.

## Stage 7: Advanced Automation
Add installment rules, voice-call adapter, legal package export, optional Textract and future bank integration.
