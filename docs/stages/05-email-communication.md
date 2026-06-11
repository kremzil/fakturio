# Stage 5: Email Intake & Communication

Goal: add debtor communication through provider abstraction.

Status: baseline complete. Inbound replies, deterministic reply policy, reminder 2 and standard installment communication are implemented.

Deliverables:
- SES provider target.
- Mailpit SMTP and fixture local development paths.
- Outbound customer payment-check email through `EmailProvider`.
- Raw MIME parser with message thread headers and attachments.
- Trusted SES inbound adapter endpoint.
- Signed case Reply-To addresses and thread-header correlation.
- Immediate template-based first debtor reminder after confirmed non-payment.
- Debtor reply classification through `AiProvider`.
- Worker-side classification triggered through durable commands.
- Promise, dispute, unclear reply and amount-mismatch policy.
- Standard three-payment installment proposal and explicit acceptance.
- Reminder 2 after a failed follow-up payment check.
- Stored inbound attachments that never count as payment proof.
- Reply attachment allowlist and count/per-file/total-size limits before storage.

Acceptance criteria:
- Outbound payment-check/reminder creates `Communication`.
- Concurrent or retried payment-check activities do not call the provider simultaneously for the same idempotency key.
- Failed sends remain retryable; successful sends and their audit event are confirmed transactionally.
- Missing debtor/customer recipient data pauses automation instead of continuously retrying the workflow loop.
- Local `EMAIL_DRIVER=mailpit` messages appear in Mailpit.
- Inbound reply is classified and appears in case timeline.
- Replayed invoice and reply messages are idempotent.
- Debtor `PAID` classification does not close a case without customer confirmation.
- First reminder is sent only for an organization-scoped `OVERDUE` case and advances it to `EMAIL_REMINDER_1_SENT` after confirmed provider delivery.
- Debtor payment claims require a separate customer `PaymentCheck`.
- Promise extension is limited to one and at most ten calendar days.
- Installment dates and amounts are deterministic; a missed installment creates `CALL_REQUIRED`.
- Stale payment-check actions cannot reopen terminal cases or mutate inactive installment plans.
- Version 1 payment-check tokens remain verifiable only for already-issued, unexpired links; all new links use version 2.
- Installment due dates are finalized from the explicit acceptance timestamp.

Remaining:
- complete production legal review of Slovak reminder 2 and broken-plan wording;
- add payment request/final notice policy after reminder 2;
- expose promises, disputes and installment plans in the dashboard;
- connect the future voice adapter to `CALL_REQUIRED`.
