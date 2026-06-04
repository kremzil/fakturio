# FAKTURIO

FAKTURIO — автономная SaaS-система soft-collection для контроля неоплаченных фактур. Система принимает фактуры, создаёт case, контролирует дату splatnosti, ведёт коммуникацию с должником по заданному workflow и готовит историю дела для заказчика.

AI используется как инструмент внутри backend workflow: распознаёт фактуры, классифицирует ответы, готовит черновики писем и summary. Юридические действия и нестандартные условия требуют решения человека.

## Стек

- Monorepo: npm workspaces
- Web: Next.js 16 App Router, TypeScript, Tailwind/shadcn-ready UI
- Auth: Auth.js + Prisma
- DB: PostgreSQL + Prisma
- Workflow: Temporal
- AI: OpenAI Responses API + Structured Outputs
- Storage: MinIO локально, AWS S3 в production
- Email: fixture/Mailpit локально, Amazon SES в production

## Быстрый старт

```bash
npm install
docker compose up -d
npm run db:migrate
npm run dev
```

Адреса:

- Web: http://localhost:3000
- Temporal UI: http://localhost:8088
- MinIO console: http://localhost:9001
- Mailpit: http://localhost:8025

## Environment

Скопируйте `.env.example` в `.env` и заполните значения. Для локальной разработки можно оставить `MOCK_AI=1`. Для реального парсинга задайте `OPENAI_API_KEY` и `MOCK_AI=0`.

`.env` не должен попадать в git.

## Текущий bootstrap scope

Репозиторий уже переведён на целевую структуру:

- `apps/web` содержит первый рабочий dashboard и route handlers для upload/confirm/mark-paid.
- `apps/worker` содержит Temporal worker skeleton.
- `packages/ai` содержит перенесённый OpenAI invoice parser.
- `packages/db` содержит новую PostgreSQL Prisma schema.
- `packages/intake` содержит общий pipeline приёма фактур из upload и email.
- `packages/storage` и `packages/email` фиксируют S3/SES target через provider abstraction.

## Текущий intake flow

Фактура может попасть в систему двумя путями:

- UI upload: `POST /api/cases/upload`
- локальный email fixture: `POST /api/dev/email-inbound`

Оба пути вызывают `InvoiceIntakeService`:

```text
source upload/email
  -> email alias resolves Organization when source is email
  -> StorageProvider.putObject()
  -> AiProvider.extractInvoice()
  -> resolve Customer/Debtor inside Organization
  -> Case + InvoiceDocument + CaseEvent
  -> human review
  -> confirm
  -> Temporal CaseWorkflow
```

Контрагенты не создаются каждый раз заново: `packages/intake` ищет существующего `Debtor` внутри `Organization` по IČO, IČ DPH, DIČ, email, нормализованному названию и адресу. Повторные фактуры одного должника должны попадать в одну карточку контрагента.

После подтверждения фактуры case переходит в `WAITING_FOR_DUE_DATE`. Worker стартует Temporal workflow для подтверждённых case, ждёт дату splatnosti из фактуры и отправляет заказчику email с двумя действиями:

- `Оплата поступила` -> case закрывается как `CLOSED_PAID`.
- `Оплата не поступила` -> case переходит в `OVERDUE`, после чего могут начинаться следующие collection steps.

Ссылки подписываются отдельным HMAC-секретом и имеют TTL. Открытие ссылки через `GET` показывает read-only страницу подтверждения и не меняет case; переход состояния выполняется только после явного `POST`. Worker использует `Communication` как outbox с idempotency key и атомарным send lease, чтобы параллельные Temporal activity не отправляли одно письмо одновременно.

Доступ dashboard/API к case всегда ограничивается активной `Organization`. В production локальный Credentials provider и fallback на `local-user` отключены.

Пример локального email fixture:

```bash
curl -X POST http://localhost:3000/api/dev/email-inbound \
  -H "Content-Type: application/json" \
  -d "{\"from\":\"sender@example.com\",\"subject\":\"Faktura\",\"attachments\":[{\"fileName\":\"invoice.pdf\",\"mimeType\":\"application/pdf\",\"base64\":\"...\"}]}"
```

`/api/dev/email-inbound` отключён в production. Production inbound/outbound email target: Amazon SES.

## Проверки

```bash
npm test
npm run test:integration
npm run build
```
