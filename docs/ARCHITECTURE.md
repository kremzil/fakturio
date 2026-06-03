# Architecture

## Monorepo Layout

```text
apps/
  web/       Next.js dashboard and route handlers
  worker/    Temporal worker process
packages/
  db/        Prisma schema and DB client
  ai/        OpenAI provider and AI contracts
  workflows/ Temporal workflow contracts
  email/     SES/Mailpit provider abstraction
  storage/   S3/MinIO provider abstraction
  shared/    shared schemas, DTOs, status machine
```

## Data Flow

```text
invoice file
  -> apps/web route handler
  -> packages/storage stores original file
  -> packages/ai extracts structured invoice data
  -> packages/db creates Case, InvoiceDocument, CaseEvent
  -> apps/worker later runs CaseWorkflow
```

## Provider Targets

- StorageProvider: MinIO locally, AWS S3 in production.
- EmailProvider: fixture/Mailpit locally, Amazon SES in production.
- AiProvider: mock locally when `MOCK_AI=1`, OpenAI in real mode.
- Temporal activities: DB/email/storage/AI side effects stay outside workflow code.

## State Ownership

The database is the source of truth. Temporal owns durable waiting and scheduled workflow execution. AI never owns state transitions; it returns structured data used by backend validation and workflow rules.
