# Stage 5: Email Intake & Communication

Goal: add debtor communication through provider abstraction.

Deliverables:
- SES provider target.
- Mailpit SMTP and fixture local development paths.
- Outbound customer payment-check email through `EmailProvider`.
- Inbound email parser contract.
- Debtor reply classification through `AiProvider`.

Acceptance criteria:
- Outbound payment-check/reminder creates `Communication`.
- Concurrent or retried payment-check activities do not call the provider simultaneously for the same idempotency key.
- Failed sends remain retryable; successful sends and their audit event are confirmed transactionally.
- Local `EMAIL_DRIVER=mailpit` messages appear in Mailpit.
- Inbound reply is classified and appears in case timeline.
