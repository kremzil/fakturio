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

Case state changes that must wake a workflow are written to `WorkflowCommand` in the same database transaction as the state transition. The worker claims commands with a lease and delivers them with Temporal `signalWithStart`. Signals are wake-up notifications only; the workflow reloads the organization-scoped case snapshot from PostgreSQL before deciding what to do.

Temporal uses separate local databases (`temporal`, `temporal_visibility`) from the application database (`fakturio`) so Prisma migrations only manage application tables.

Workflow changes that alter command names, timers or activity ordering require a replay-compatible rollout. Patch `case-collection-loop-v1` preserves the pre-change execution path while new executions use the interruptible collection loop. Patch `overdue-reminder-loop-guard-v1` adds the post-reminder state verification without changing replay of executions that already passed that branch. During the rollout, the dispatcher sends `caseCommand` and also sends legacy `caseStateChanged` for case-state commands. Legacy branches stay deployed until all pre-patch executions complete or are explicitly migrated. Their removal requires a `deprecatePatch` deployment followed by a separate cleanup deployment. Replay tests against captured legacy history are required before either rollout step.

## Payment Check Workflow

Confirming a reviewed invoice sets the case to `WAITING_FOR_DUE_DATE` and records a workflow start request. The worker scans confirmed cases without `workflowId`, starts `caseWorkflow`, and stores the deterministic workflow id `case-{caseId}`.

`caseWorkflow` waits until the invoice due date and then remains active until a terminal case status. Timers and durable signals are handled in the same deterministic loop. On a control date, the worker creates a concrete `PaymentCheck` and sends its actions to the customer account user through `EmailProvider`:

- `EMAIL_DRIVER=mailpit` locally writes to Mailpit SMTP.
- `EMAIL_DRIVER=ses` uses Amazon SES in production.

The email contains two action links:

- `/api/cases/:caseId/payment-check/paid` closes the case as `CLOSED_PAID`.
- `/api/cases/:caseId/payment-check/not-paid` marks the case `OVERDUE` and records that collection can continue.

The links carry time-limited HMAC tokens bound to the payment check, case, organization and action. `GET` only renders a read-only confirmation page so email scanners and link previews cannot mutate state. The transition is applied only by an explicit token-authorized `POST`, using an atomic claim so concurrent/replayed actions resolve one check once.

Token version 2 binds actions to a concrete `PaymentCheck`. The verifier also accepts legacy version 1 tokens until all already-issued links have expired, but the signer emits only version 2. Terminal cases and payment checks whose expected case/plan/installment state no longer matches are rejected before mutation.

Payment-check delivery uses `Communication` as a durable outbox:

- `idempotencyKey` identifies one payment-check message for a case and due date.
- An atomic `sendLeaseId` / `sendLeaseUntil` claim ensures only one concurrent activity calls the email provider.
- Retry reclaim refreshes the stored recipient, body and action tokens before sending.
- Marking the communication `SENT` and recording the audit `CaseEvent` happen in one transaction.
- Activity timeout and lease TTL are shared workflow constants; the lease includes a grace interval beyond the Temporal timeout.

When the customer explicitly selects `NOT_PAID`, the case moves to `OVERDUE` and the workflow immediately sends the first debtor reminder. The reminder is deterministic template content built from reviewed case data and does not use AI. Its requested payment date defaults to 10 calendar days after sending and is configurable through `DEBTOR_FIRST_REMINDER_PAYMENT_DAYS`.

The reminder uses its own durable `Communication` idempotency key and send lease. Immediately before calling the provider, the activity verifies that the organization-scoped case is still `OVERDUE`. A successful transactional confirmation advances it to `EMAIL_REMINDER_1_SENT` and records `EMAIL_SENT`. A missing debtor or customer email atomically pauses automation with a reason and clears `nextActionAt`, preventing a retry hot loop.

## Inbound Email And Reply Classification

`packages/email` parses raw RFC 822/MIME messages and preserves `Message-ID`, `In-Reply-To`, `References`, body and attachments. Production SES ingress uses a trusted receipt/Lambda/S3 adapter that posts raw MIME to `/api/email/inbound/ses`.

Inbound processing order:

1. Match a signed case-specific reply address when the sending adapter has assigned one.
2. Match `In-Reply-To` or `References` to a stored outbound `Communication`.
3. Otherwise resolve an active organization `EmailIntakeAddress` and process the message as invoice intake.

Replies are idempotent by provider message id. Web intake stores `Communication(INBOUND)`, accepted `CommunicationAttachment` objects and a `DEBTOR_REPLY_RECEIVED` command without calling AI. Reply attachments are limited to 10 files, 10 MB each and 20 MB total, with PDF/JPEG/PNG/WEBP allowlisted. Rejected attachment metadata remains in the communication audit payload, but rejected bytes are not written to storage. The worker classifies readable text through `AiProvider` and applies deterministic policy. Attachments are retained for audit but never treated as proof of payment.

Sender mismatch and automated replies are recorded and ignored. Low-confidence, contradictory, invalid-date and repeated unclear replies pause or request clarification. AI never changes a debt amount: a partial or different amount forces manual review. A debtor payment claim creates a new customer `PaymentCheck`; only the customer response can close the case.

The first accepted payment promise may move the next check by at most ten calendar days. Further promises do not extend it. Disputes notify the customer and pause automation.

## Installment Plans

A standard plan is deterministic and pre-authorized: three installments due `+5`, `+19` and `+33` calendar days after explicit acceptance. Proposal dates are shown to the debtor, but persisted due dates are recalculated atomically from the actual acceptance time so a delayed reply cannot activate an already-due first installment. The first two amounts use `floor(total cents / 3)` and the final amount closes the rounding remainder.

`InstallmentPlan` and `InstallmentPayment` are persisted only after the proposal flow. Temporal waits for each payment due date and creates a dedicated `PaymentCheck`. Confirmed payments advance to the next installment; the third closes the case. A missed installment marks the plan and case broken, sends template notices, and creates an idempotent `CALL_REQUIRED` timeline event for a future voice adapter.

The first debtor reminder uses the signed case-specific address as `Reply-To`, while payment-check messages sent to the customer account user continue to use signed HTTP actions.
