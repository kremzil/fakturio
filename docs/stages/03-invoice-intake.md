# Stage 3: Invoice Intake

Goal: recreate and improve the parser MVP on the target stack.

Deliverables:
- Upload route handler in `apps/web`.
- Dev email intake endpoint and future SES-compatible routing boundary.
- Shared `InvoiceIntakeService` for upload and email sources.
- `EmailIntakeAddress` routing from inbound address to `Organization`.
- Organization-scoped counterparty matching for repeat debtors.
- Original file storage through `StorageProvider`.
- OpenAI parser in `packages/ai`.
- Manual review fallback.
- Confirm endpoint for payment monitoring readiness.

Acceptance criteria:
- PDF and image inputs use correct Responses API formats.
- Parse failure creates `MANUAL_REVIEW_REQUIRED`.
- Confirm blocks missing invoice number, due date, amount or debtor.
- Repeat invoices for the same debtor attach to the same `Debtor` when strong identifiers match.
- Upload and email attachments both produce `Case` + `InvoiceDocument` through the same service.
