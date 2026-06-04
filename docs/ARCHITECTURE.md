# Architecture

## Monorepo Layout

```text
apps/
  web/       Next.js dashboard and route handlers
  worker/    Temporal worker process
packages/
  db/        Prisma schema and DB client
  ai/        OpenAI provider and AI contracts
  intake/    shared invoice intake pipeline for upload and email
  workflows/ Temporal workflow contracts
  email/     SES/Mailpit provider abstraction
  storage/   S3/MinIO provider abstraction
  shared/    shared schemas, DTOs, status machine
```

## Data Flow

```text
UI upload or inbound email
  -> apps/web route handler
  -> inbound email address resolves Organization when the source is email
  -> packages/intake normalizes source as UPLOAD or EMAIL
  -> packages/storage stores original file
  -> packages/ai extracts structured invoice data
  -> packages/intake resolves Customer/Debtor within Organization
  -> packages/db creates Case, InvoiceDocument, Communication when email, CaseEvent
  -> apps/worker later runs CaseWorkflow
```

Email intake stores inbound messages as `Communication` records. Each supported PDF/image attachment becomes an `InvoiceDocument` and follows the same parser/review/confirm pipeline as manual upload. Unsupported email attachments are recorded as skipped metadata; emails without supported attachments create a `MANUAL_REVIEW_REQUIRED` case.

## Organization And Counterparty Matching

`Organization` is the customer account in FAKTURIO. Inbound email routing is represented by `EmailIntakeAddress`, so addresses like `invoices@fakturio.local` or future customer aliases can point to the correct organization before parsing starts.

Counterparties are scoped to an organization. `Debtor` is the debtor/customer's counterparty on the invoice. `Customer` currently stores the parsed supplier snapshot as a structured organization-scoped party; this may later collapse into an organization legal profile.

`packages/intake` resolves parsed parties before attaching a case:

1. IČO
2. IČ DPH
3. DIČ
4. email
5. normalized name + normalized address
6. unique normalized name within the organization

The resolver updates known fields without overwriting existing identifiers with empty values. Match metadata is written to the parse event payload for auditability.

## Authentication And Tenant Boundary

Auth.js resolves the authenticated user, while `requireSession()` resolves and verifies the active `Organization`. Production never falls back to the local bootstrap user, and the passwordless local Credentials provider is disabled outside development.

All customer-facing case reads and mutations must include `organizationId`. Web routes use organization-scoped case helpers with a narrow mutation allowlist; Temporal activities receive both `caseId` and `organizationId` and verify the pair before side effects. A globally unique `caseId` is an identifier, not authorization.

## Provider Targets

- StorageProvider: MinIO locally, AWS S3 in production.
- EmailProvider: fixture/Mailpit locally, Amazon SES in production.
- AiProvider: mock locally when `MOCK_AI=1`, OpenAI in real mode.
- Temporal activities: DB/email/storage/AI side effects stay outside workflow code.

## State Ownership

The database is the source of truth. Temporal owns durable waiting and scheduled workflow execution. AI never owns state transitions; it returns structured data used by backend validation and workflow rules.

Temporal uses separate local databases (`temporal`, `temporal_visibility`) from the application database (`fakturio`) so Prisma migrations only manage application tables.

## Payment Check Workflow

Confirming a reviewed invoice sets the case to `WAITING_FOR_DUE_DATE` and records a workflow start request. The worker scans confirmed cases without `workflowId`, starts `caseWorkflow`, and stores the deterministic workflow id `case-{caseId}`.

`caseWorkflow` waits until the invoice due date. On that date, if the case is still waiting, the worker sends a payment-check email to the customer account user through `EmailProvider`:

- `EMAIL_DRIVER=mailpit` locally writes to Mailpit SMTP.
- `EMAIL_DRIVER=ses` uses Amazon SES in production.

The email contains two action links:

- `/api/cases/:caseId/payment-check/paid` closes the case as `CLOSED_PAID`.
- `/api/cases/:caseId/payment-check/not-paid` marks the case `OVERDUE` and records that collection can continue.

The links carry time-limited HMAC tokens bound to the case, organization and action. `GET` only renders a read-only confirmation page so email scanners and link previews cannot mutate state. The transition is applied only by an explicit token-authorized `POST`, using an optimistic conditional update so concurrent/replayed actions cannot regress the case.

Payment-check delivery uses `Communication` as a durable outbox:

- `idempotencyKey` identifies one payment-check message for a case and due date.
- An atomic `sendLeaseId` / `sendLeaseUntil` claim ensures only one concurrent activity calls the email provider.
- Retry reclaim refreshes the stored recipient, body and action tokens before sending.
- Marking the communication `SENT` and recording the audit `CaseEvent` happen in one transaction.
- Activity timeout and lease TTL are shared workflow constants; the lease includes a grace interval beyond the Temporal timeout.
