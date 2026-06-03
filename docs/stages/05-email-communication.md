# Stage 5: Email Intake & Communication

Goal: add debtor communication through provider abstraction.

Deliverables:
- SES provider target.
- Mailpit/fixture local development path.
- Inbound email parser contract.
- Debtor reply classification through `AiProvider`.

Acceptance criteria:
- Outbound reminder creates `Communication`.
- Inbound reply is classified and appears in case timeline.
