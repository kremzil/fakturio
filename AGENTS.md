# FAKTURIO Agent Guide

## Mission
FAKTURIO is an autonomous B2B soft-collection system for unpaid invoices. It ingests invoices, creates collection cases, monitors due dates, communicates with debtors, records promises/disputes, and prepares case history for customer review.

The hard product boundary: AI may extract, classify, draft, summarize, and recommend inside predefined workflows. AI must not change debt amounts, approve non-standard terms, threaten debtors, file legal documents, or perform legal actions for a customer.

## Target Architecture
- `apps/web`: Next.js 16 App Router dashboard, route handlers, customer-facing flows.
- `apps/worker`: Temporal worker for durable collection workflows.
- `packages/db`: Prisma schema, migrations, and DB client.
- `packages/ai`: OpenAI provider and structured output schemas.
- `packages/workflows`: Temporal workflow contracts and deterministic workflow code.
- `packages/email`: email provider abstraction; local fixtures/Mailpit, production Amazon SES.
- `packages/storage`: storage provider abstraction; local MinIO, production AWS S3.
- `packages/shared`: Zod schemas, DTOs, status machine, validation.

Business logic belongs in packages, not React components. Next.js is the customer/admin interface and backend-for-frontend layer.

## Commands
- `npm install`
- `docker compose up -d`
- `npm run db:migrate`
- `npm run dev`
- `npm test`
- `npm run build`

Next.js runs at `http://localhost:3000`. Temporal UI runs at `http://localhost:8088`. MinIO console runs at `http://localhost:9001`. Mailpit runs at `http://localhost:8025`.

## Engineering Rules
- Keep `.env` uncommitted. Real API keys must never be printed, logged, or staged.
- Use PostgreSQL Prisma migrations for schema changes.
- Add or update tests for parser, status transitions, route handlers, workflow activities, storage/email contracts, and validation.
- Preserve auditability: every meaningful automated or user action should create a `CaseEvent`.
- Use provider interfaces for OpenAI, S3, SES, and Temporal activities.
- Keep Temporal workflow code deterministic; perform side effects only in activities.
- Before using Next.js APIs, consult the official Next.js docs/MCP for the current version.

## Local Defaults
- `MOCK_AI=1` is acceptable for local smoke tests.
- MinIO is only the local S3-compatible stand-in. Production target is AWS S3.
- Fixture/Mailpit email is only for local development. Production target is Amazon SES.
