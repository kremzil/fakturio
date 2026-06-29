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

- `apps/web` содержит operational dashboard и route handlers для upload, review, confirm и ручного управления case.
- `apps/worker` содержит Temporal worker, workflow starter и durable command dispatcher.
- `packages/ai` содержит перенесённый OpenAI invoice parser.
- `packages/db` содержит новую PostgreSQL Prisma schema.
- `packages/intake` содержит общий pipeline приёма фактур из upload и email.
- `packages/storage` и `packages/email` фиксируют S3/SES target через provider abstraction.
- Production inbound email может приниматься через SES receipt rule в S3; worker забирает raw MIME из bucket и запускает тот же intake pipeline.

## Текущий intake flow

Фактура может попасть в систему двумя путями:

- UI upload: `POST /api/cases/upload`
- локальный email fixture: `POST /api/dev/email-inbound`
- production SES inbound: `SES -> S3 inbound/ -> apps/worker poller`

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

После подтверждения фактуры case переходит в `WAITING_FOR_DUE_DATE`. Worker стартует Temporal workflow с детерминированным id `case-{caseId}`, ждёт дату splatnosti из фактуры и отправляет заказчику email с двумя действиями:

- `Оплата поступила` -> case закрывается как `CLOSED_PAID`.
- `Оплата не поступила` -> case переходит в `OVERDUE`, workflow сразу отправляет должнику первое шаблонное напоминание и переводит case в `EMAIL_REMINDER_1_SENT`.

Ссылки подписываются отдельным HMAC-секретом и имеют TTL. Открытие ссылки через `GET` показывает read-only страницу подтверждения и не меняет case; переход состояния выполняется только после явного `POST`. Worker использует `Communication` как outbox с idempotency key и атомарным send lease, чтобы параллельные Temporal activity не отправляли одно письмо одновременно.

Изменения `PAID`/`NOT_PAID` записываются в PostgreSQL вместе с `WorkflowCommand`. Worker доставляет команду через Temporal `signalWithStart`, а повторная доставка дедуплицируется по `commandId`. Поэтому web-запрос не зависит от доступности Temporal в этот момент, а workflow остаётся активным до ответа.

Текущий workflow rollout защищён Temporal patch `case-collection-loop-v1`. Старые executions продолжают воспроизводить прежнюю историю и получают совместимый сигнал `caseStateChanged`; новые используют `caseCommand` и прерываемые ожидания таймеров. Legacy-ветку нельзя удалять, пока все executions, стартовавшие до этого rollout, не завершены или не мигрированы. После этого сначала выпускается `deprecatePatch`, и только отдельным последующим deploy удаляется старая ветка.

Первое письмо должнику генерируется без AI из проверенных данных case: заказчик/кредитор, номер и сумма фактуры, исходная дата splatnosti, IBAN, variabilný symbol и назначение платежа. Письмо отправляется сразу после ответа `Оплата не поступила`; срок добровольной оплаты по умолчанию составляет 10 календарных дней и задаётся через `DEBTOR_FIRST_REMINDER_PAYMENT_DAYS`. В `Reply-To` используется подписанный case-specific адрес для последующей привязки ответа к делу.

Входящее письмо сначала сопоставляется с существующим case по подписанному case-specific адресу или заголовкам `In-Reply-To`/`References`. Web intake сохраняет `Communication(INBOUND)`, разрешённые вложения и durable `WorkflowCommand`; AI-классификация выполняется worker activity. Для ответов должника принимаются PDF/JPEG/PNG/WEBP: максимум 10 файлов, 10 MB на файл и 20 MB суммарно. Отклонённые вложения фиксируются в metadata, но не сохраняются в storage. Вложения не считаются доказательством оплаты.

После первого reminder workflow остаётся активным:

- `PAID` отправляет заказчику отдельный одноразовый `PaymentCheck`;
- первое обещание оплаты переносит проверку не более чем на 10 календарных дней, повторное обещание срок не меняет;
- спор уведомляет заказчика и ставит автоматизацию на паузу;
- неясный ответ уточняется один раз, повторная неопределённость ставит case на паузу;
- несовпадающая или частичная сумма переводит case в ручную проверку.

Просьба о рассрочке получает шаблонный план из трёх платежей: `+5`, `+19` и `+33` календарных дня. План активируется только после явного согласия со всеми суммами и датами; окончательные даты пересчитываются от даты акцепта. Каждый взнос имеет собственный `PaymentCheck`; третий подтверждённый платёж закрывает case. Неполученный взнос переводит case в `INSTALLMENT_BROKEN`, отправляет уведомления и создаёт событие `CALL_REQUIRED`.

Если отсутствует email должника или заказчика, activity ставит автоматизацию на паузу с явной причиной вместо повторного запуска отправки. Просроченные действия payment-check не могут изменить terminal case или уже завершённый/сломанный план рассрочки.

Новые payment-check письма используют токен версии 2, привязанный к конкретному `PaymentCheck`. Проверка временно принимает ранее отправленные токены v1 до истечения их встроенного TTL; генерация новых v1 токенов запрещена. Поддержку v1 можно удалить только после истечения максимального срока жизни всех старых ссылок.

Если повторный контроль после reminder 1 подтверждает отсутствие оплаты, workflow немедленно отправляет reminder 2. Его словацкий юридический текст должен пройти отдельную проверку перед production.

Если case не найден, письмо маршрутизируется по `EmailIntakeAddress` и проходит обычный invoice intake. Повторная доставка одного SES сообщения не создаёт второй case. Для SES/S3 режима worker читает `SES_INBOUND_BUCKET`/`SES_INBOUND_PREFIX`, парсит raw MIME, после успешной обработки перемещает объект в `SES_INBOUND_PROCESSED_PREFIX`, а непонятные или не смаршрутизированные письма - в `SES_INBOUND_FAILED_PREFIX`. Poller включается при `EMAIL_DRIVER=ses` или `SES_INBOUND_POLLING=1`.

Для текущего SES test-domain:

```env
EMAIL_DRIVER=ses
AWS_REGION=eu-central-1
SES_FROM_EMAIL=collection@fakturio.shark.sk
SES_AWS_ACCESS_KEY_ID=...
SES_AWS_SECRET_ACCESS_KEY=...
SES_INBOUND_BUCKET=fakturio-ses-inbound-728312363829-eu-central-1
SES_INBOUND_PREFIX=inbound/
SES_INBOUND_PROCESSED_PREFIX=processed/
SES_INBOUND_FAILED_PREFIX=failed/
INBOUND_REPLY_DOMAIN=fakturio.shark.sk
INBOUND_INTAKE_ADDRESSES=invoices@fakturio.shark.sk
```

Доступ dashboard/API к case всегда ограничивается активной `Organization`. В production локальный Credentials provider и fallback на `local-user` отключены.

Dashboard показывает общую очередь, состояния внимания, активные promises и installment plans, timeline, коммуникации и payment checks. Оператор может редактировать распознанную фактуру до подтверждения, отметить оплату, временно остановить/возобновить автоматизацию или окончательно закрыть case как отменённый. Каждое ручное действие создаёт audit event и durable `WorkflowCommand`.

Пример локального email fixture:

```bash
curl -X POST http://localhost:3000/api/dev/email-inbound \
  -H "Content-Type: application/json" \
  -d "{\"from\":\"sender@example.com\",\"subject\":\"Faktura\",\"attachments\":[{\"fileName\":\"invoice.pdf\",\"mimeType\":\"application/pdf\",\"base64\":\"...\"}]}"
```

`/api/dev/email-inbound` отключён в production. `POST /api/email/inbound/ses` остаётся совместимым вариантом для будущего trusted SES/Lambda adapter с `Authorization: Bearer $INBOUND_EMAIL_WEBHOOK_SECRET`, но текущий VPS-friendly путь - SES receipt rule, S3 bucket и worker poller.

## Ближайший следующий этап

- добавить экспорт полной истории case и отдельную очередь disputes;
- выполнить полный Mailpit smoke с реальным web/worker процессом;
- после юридической проверки добавить последующие escalation steps после reminder 2;
- подключить voice adapter к событию `CALL_REQUIRED`.

## Проверки

```bash
npm test
npm run test:integration
npm run build
```
