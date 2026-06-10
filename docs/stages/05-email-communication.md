# Stage 5: Email Intake & Communication

Goal: add debtor communication through provider abstraction.

Status: inbound foundation and customer payment-check communication are implemented. Automated debtor reminders are still pending.

Deliverables:
- SES provider target.
- Mailpit SMTP and fixture local development paths.
- Outbound customer payment-check email through `EmailProvider`.
- Raw MIME parser with message thread headers and attachments.
- Trusted SES inbound adapter endpoint.
- Signed case Reply-To addresses and thread-header correlation.
- Debtor reply classification through `AiProvider`.

Acceptance criteria:
- Outbound payment-check/reminder creates `Communication`.
- Concurrent or retried payment-check activities do not call the provider simultaneously for the same idempotency key.
- Failed sends remain retryable; successful sends and their audit event are confirmed transactionally.
- Local `EMAIL_DRIVER=mailpit` messages appear in Mailpit.
- Inbound reply is classified and appears in case timeline.
- Replayed invoice and reply messages are idempotent.
- Debtor `PAID` classification does not close a case without customer confirmation.

Remaining:
- set the signed case-specific address as `Reply-To` on outbound debtor emails;
- implement reminder 1/2, payment request and final notice activities;
- convert classified promises/disputes into reviewed domain actions and workflow signals.
