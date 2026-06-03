# Stage 3: Invoice Intake

Goal: recreate and improve the parser MVP on the target stack.

Deliverables:
- Upload route handler in `apps/web`.
- Original file storage through `StorageProvider`.
- OpenAI parser in `packages/ai`.
- Manual review fallback.
- Confirm endpoint for payment monitoring readiness.

Acceptance criteria:
- PDF and image inputs use correct Responses API formats.
- Parse failure creates `MANUAL_REVIEW_REQUIRED`.
- Confirm blocks missing invoice number, due date, amount or debtor.
