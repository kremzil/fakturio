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
- `packages/storage` и `packages/email` фиксируют S3/SES target через provider abstraction.

## Проверки

```bash
npm test
npm run build
```
