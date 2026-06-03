# Stage 2: Database & Domain Model

Goal: make PostgreSQL case-domain schema the source of truth.

Deliverables:
- Auth.js Prisma models.
- Organization and membership models.
- Case, invoice document, event, communication and payment-promise models.
- Status machine tests in `packages/shared`.

Acceptance criteria:
- Prisma generate succeeds.
- A case can be created from an uploaded invoice.
- Every status-changing action writes a `CaseEvent`.
