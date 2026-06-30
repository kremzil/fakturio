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
  -> packages/ai triages multiple supported email attachments before parsing
  -> packages/storage stores original file
  -> packages/ai extracts structured invoice data
  -> packages/intake resolves Customer/Debtor within Organization
  -> packages/db creates Case, InvoiceDocument, Communication when email, CaseEvent
  -> apps/worker later runs CaseWorkflow
```

Email intake stores inbound messages as `Communication` records. A single supported PDF/image attachment follows the same parser/review/confirm pipeline as manual upload. Multiple supported attachments are triaged first. At confidence `>= 0.90`, separate invoice groups create separate cases, while supporting documents are retained as `CommunicationAttachment` history on the related case. Low-confidence or invalid grouping creates one `MANUAL_REVIEW_REQUIRED` container case, stores all accepted documents as communication attachments, and asks the customer to clarify which documents are invoices versus attachments. Unsupported email attachments are recorded as skipped metadata; emails without supported attachments create a `MANUAL_REVIEW_REQUIRED` case.

## Organization And Counterparty Matching

`Organization` is the customer account in FAKTURIO. Inbound email routing is represented by `EmailIntakeAddress`, so addresses like `invoices@fakturio.local` or customer-specific aliases point to the correct organization before parsing starts. Production intake aliases must be unique per customer, for example `abc-sro@fakturio.shark.sk`. The shared sender address `collection@fakturio.shark.sk` is not an intake address for new invoices. Sender `From` checks may be used as an additional allowlist control, but customer identity is resolved from the recipient alias.

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

Workflow changes that alter command names, timers or activity ordering require a replay-compatible rollout. Patch `case-collection-loop-v1` preserves the pre-change execution path while new executions use the interruptible collection loop. Patch `overdue-reminder-loop-guard-v1` adds the post-reminder state verification without changing replay of executions that already passed that branch. Patch `scheduled-noop-guard-v1` records and parks unexpected scheduled states instead of silently looping. During the rollout, the dispatcher sends `caseCommand` and also sends legacy `caseStateChanged` for case-state commands. Legacy branches stay deployed until all pre-patch executions complete or are explicitly migrated. Their removal requires a `deprecatePatch` deployment followed by a separate cleanup deployment. Replay tests against captured legacy history are required before either rollout step.

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

If the follow-up payment check after reminder 1 is resolved as unpaid, the workflow sends reminder 2 and intentionally stops automatic escalation by clearing `nextActionAt`. This is the current soft-collection boundary. Later payment request, call and legal-preparation states remain reserved until their policy, Slovak legal wording and voice/legal adapters are implemented.

Workflow timer branches must never silently no-op. When a case has `nextActionAt` but its status is not supported by the current scheduler, the workflow records `WORKFLOW_WAITING` and parks until a command wakes it. This prevents a stale or manually edited `nextActionAt` from creating a zero-timeout busy loop.

Known workflow roadmap:

- Replace scattered cadence values with a declarative collection policy, then make it organization-configurable.
- Add the post-reminder-2 escalation policy before activating `PAYMENT_REQUEST_SENT`, `CALL_SCHEDULED`, `CALL_COMPLETED`, `FINAL_NOTICE_SENT` and `READY_FOR_LEGAL_ACTION`.
- Add `continueAsNew` or another history-size limit before long-lived production volume.
- Retire `legacyCaseWorkflow` only through a replay-safe Temporal patch deprecation rollout after old executions finish or are migrated.

## Inbound Email And Reply Classification

`packages/email` parses raw RFC 822/MIME messages and preserves `Message-ID`, `In-Reply-To`, `References`, body and attachments. Production SES ingress uses a trusted receipt/Lambda/S3 adapter that posts raw MIME to `/api/email/inbound/ses`.

Inbound processing order:

1. Match a signed customer clarification address, or a thread reply to a stored customer clarification request.
2. Match a signed debtor case-specific reply address when the sending adapter has assigned one.
3. Match `In-Reply-To` or `References` to a stored outbound debtor `Communication`.
4. Otherwise resolve an active organization `EmailIntakeAddress` and process the message as invoice intake.

Customer email assistant handling is separate from debtor reply handling. Its matcher must stay strict to signed `clarify+...` addresses, stored customer clarification threads and customer intake aliases, so it cannot capture debtor `reply+...` replies before the debtor reply processor runs. Thread correlation depends on shared `CUSTOMER_COMMUNICATION_KINDS` constants rather than ad hoc `rawPayload.kind` strings. When an emailed invoice creates a `MANUAL_REVIEW_REQUIRED` case because required invoice fields are missing, intake sends the original sender a templated clarification request with a signed `clarify+...` reply address. The same signed clarification path handles pending multi-attachment clarification: a clear reply reuses saved `CommunicationAttachment` objects through `StorageProvider.getObject()`, turns the container case into the first parsed invoice case, and creates additional cases for other primary invoices. Worker-generated customer notices about a specific case also use a signed `clarify+...` Reply-To, so the customer can reply with case instructions and the assistant will attach the message to the same timeline. Replies and case-alias emails without invoice attachments are classified through Structured Outputs. Alias messages use the same AI classification for case matching and intent handling to avoid duplicate model calls. If an alias message cannot be matched to exactly one case, the system creates a `MANUAL_REVIEW_REQUIRED` container case, stores the inbound `Communication`, and sends a follow-up asking for a concrete invoice or debtor reference.

The assistant can fill only missing invoice fields, save customer notes, update an empty debtor contact, answer factual case-status/history questions and ask follow-up questions. It may also execute a narrow set of customer-authorized actions when classification confidence is high and no manual review flag is present:

- `REQUEST_CONFIRM_INVOICE`: confirm a valid, not-yet-confirmed invoice and request workflow start.
- `REQUEST_STANDARD_INSTALLMENT_PLAN`: send the predefined three-payment installment proposal to the debtor for explicit acceptance.
- `REQUEST_SEND_DEBTOR_MESSAGE`: send an additional debtor-facing message authorized by the customer.
- `REQUEST_CUSTOM_INSTALLMENT_PLAN`: forward a customer-authorized non-standard payment proposal to the debtor as a message, without creating an accepted payment schedule.

When a case is valid for confirmation, replies include a signed confirmation link only when the customer explicitly asks to receive details for review/control. Link `GET` is read-only; only explicit `POST` confirms the case and requests workflow start. The assistant cannot overwrite reviewed amounts, close a case, mark a case paid, accept non-standard installment terms as a tracked schedule, grant discounts or perform legal actions from email.

Replies are idempotent by provider message id. Web intake stores `Communication(INBOUND)`, accepted `CommunicationAttachment` objects and a `DEBTOR_REPLY_RECEIVED` command without calling AI. Reply attachments are limited to 10 files, 10 MB each and 20 MB total, with PDF/JPEG/PNG/WEBP allowlisted. Rejected attachment metadata remains in the communication audit payload, but rejected bytes are not written to storage. The worker classifies readable text through `AiProvider` and applies deterministic policy. Attachments are retained for audit but never treated as proof of payment.

Automated replies are recorded and ignored. Sender mismatch is recorded and pauses automation for manual review, even when the message was correlated through a signed address or stored thread, because real debtors may reply from a personal, accountant or forwarded address. Low-confidence, contradictory, invalid-date and repeated unclear replies pause or request clarification. AI never changes a debt amount: a partial or different amount forces manual review in v1 rather than being accepted as a partial-payment event. A debtor payment claim creates a new customer `PaymentCheck`; only the customer response can close the case.

The first accepted payment promise may move the next check by at most ten calendar days. Further promises do not extend it. Disputes notify the customer and pause automation.

## Installment Plans

A standard plan is deterministic and pre-authorized: three installments due `+5`, `+19` and `+33` calendar days after explicit acceptance. Proposal dates are shown to the debtor, but persisted due dates are recalculated atomically from the actual acceptance time so a delayed reply cannot activate an already-due first installment. The first two amounts use `floor(total cents / 3)` and the final amount closes the rounding remainder.

`InstallmentPlan` and `InstallmentPayment` are persisted only after the proposal flow. Temporal waits for each payment due date and creates a dedicated `PaymentCheck`. Confirmed payments advance to the next installment; the third closes the case. A missed installment marks the plan and case broken, sends template notices, and creates an idempotent `CALL_REQUIRED` timeline event for a future voice adapter.

The first debtor reminder uses the signed case-specific address as `Reply-To`, while payment-check messages sent to the customer account user continue to use signed HTTP actions.
