Ниже — резюме проекта в нормальной рабочей формулировке.

# Резюме проекта: автономная система контроля оплаты и soft-collection

## 1. Концепция

Проект — это **автономная SaaS-система для контроля неоплаченных фактур и коммуникации с должниками**.

Это не “AI-помощник”, а **autonomous collection workflow**:

```text
заказчик отправляет фактуру должнику + копию в систему
↓
система регистрирует фактуру
↓
контролирует срок оплаты
↓
после просрочки сама запускает сценарий коммуникации
↓
пишет должнику email
↓
при отсутствии реакции может инициировать звонок через внешний voice-сервис
↓
фиксирует обещания оплаты / спор / запрос рассрочки
↓
уведомляет заказчика
↓
ведёт историю дела
↓
в конце готовит пакет для дальнейших юридических действий, но не совершает их сама
```

Правильная граница ответственности:

> Система самостоятельно ведёт стандартный сценарий контроля оплаты и коммуникации с должником, но не совершает юридические действия от имени заказчика. 

---

# 2. Основные слои системы

Систему логично разделить на 4 слоя:

```text
1. Invoice Intake
2. Payment Monitoring
3. Autonomous Debtor Communication
4. Customer Dashboard & Reporting
```

---

# 3. Invoice Intake

## Как начинается процесс

Заказчик отправляет фактуру должнику и одновременно добавляет систему в копию:

```text
To: dlžník / odberateľ
Cc/Bcc: system@...
```

Система принимает письмо и создаёт новое дело.

## Что делает система

```text
- принимает email
- сохраняет оригинал письма
- сохраняет вложения
- определяет заказчика
- определяет должника
- парсит фактуру
- вытаскивает ключевые данные:
  - invoice number
  - amount
  - currency
  - due date / splatnosť
  - VS / variabilný symbol
  - IBAN
  - debtor name
  - debtor email
  - debtor company ID, если есть
- создаёт case
- ставит статус WAITING_FOR_DUE_DATE
```

## Парсинг фактуры на первом этапе

На первом этапе парсинг делаем **силами OpenAI-модели**:

```text
Email body + PDF attachment
↓
OpenAI API
↓
Structured JSON result
↓
backend validation
↓
case creation
```

Для этого хорошо подходят **Structured Outputs**, потому что они позволяют получать результат по заданной JSON-схеме, а не просто свободный текст. ([OpenAI Platform][1])

Пример выходной структуры:

```json
{
  "invoice_number": "2026-00124",
  "amount": 450.00,
  "currency": "EUR",
  "due_date": "2026-06-30",
  "variable_symbol": "202600124",
  "iban": "SK...",
  "customer": {
    "name": "Firma A s.r.o.",
    "email": "..."
  },
  "debtor": {
    "name": "Firma B s.r.o.",
    "email": "..."
  },
  "confidence": {
    "overall": 0.92,
    "manual_review_required": false,
    "reason": null
  }
}
```

Если модель не уверена в данных, дело уходит в:

```text
MANUAL_REVIEW_REQUIRED
```

## Возможное развитие: Textract

На первом этапе **Textract не обязателен**.

Позже можно добавить:

```text
Amazon Textract → OCR / field extraction
OpenAI → нормализация / проверка / бизнес-логика
```

То есть Textract может стать дополнительным extraction layer, особенно если будет много сканов, фото, кривых PDF или фактур с плохой структурой.

---

# 4. Payment Monitoring

До даты оплаты система ничего не делает с должником, а только контролирует срок.

Основной статус:

```text
WAITING_FOR_DUE_DATE
```

После наступления `due_date` система запускает сценарий soft-collection.

## Как система узнаёт, что фактура оплачена

На первом этапе — без банковской интеграции.

MVP-логика:

```text
- заказчик может вручную отметить фактуру как оплаченную в кабинете
- заказчик может нажать кнопку в email: "Označiť ako uhradené"
- если заказчик не отметил оплату, система продолжает workflow
```

Также можно сделать периодический email заказчику:

```text
Faktúra č. 2026-00124 je po splatnosti.
Ak bola uhradená, kliknite sem.
Ak neuhradíte status, systém bude pokračovať vo vymáhaní.
```

## Банковская интеграция

Интеграцию с банком пока помечаем как **possible future plan**.

В будущем можно добавить:

```text
- импорт банковских выписок CSV
- PSD2 / open banking
- GoCardless
- Salt Edge
- сверка по IBAN + VS + amount
```

Но для MVP это лучше не брать. Это усложнит проект, юридику, безопасность и onboarding.

---

# 5. Autonomous Debtor Communication

Это ядро продукта.

После просрочки система сама ведёт коммуникацию по заранее заданным правилам.

Пример стандартного сценария:

```text
DUE_DATE + 1 день:
  мягкое email-напоминание

DUE_DATE + 4 дня:
  второе email-напоминание

DUE_DATE + 7 дней:
  формальная výzva na zaplatenie

DUE_DATE + 10 дней:
  звонок через внешний AI/voice-сервис

DUE_DATE + 14 дней:
  final reminder / draft predžalobná výzva

DUE_DATE + 21 день:
  case status = READY_FOR_LEGAL_ACTION
```

Сценарии должны быть настраиваемыми:

```text
Workflow A: Soft
Workflow B: Standard
Workflow C: Strict
```

## Что AI может делать

AI может:

```text
- распознать фактуру
- классифицировать ответ должника
- понять: оплатил / обещал / спорит / просит рассрочку / игнорирует
- подготовить email
- вести звонок по утверждённому сценарию
- предложить рассрочку в рамках заданных правил
- сделать summary дела
- подготовить пакет документов
```

## Что AI не должен делать

AI не должен:

```text
- менять сумму долга
- списывать часть долга
- угрожать должнику
- утверждать нестандартные условия
- подавать документы в суд
- делать юридические действия от имени заказчика
```

Обычные шаги выполняются автоматически. Нестандартные и юридически значимые — требуют подтверждения.

---

# 6. Splátkový kalendár

Система может предлагать рассрочку, но только в рамках заранее заданных правил заказчика.

Пример правил:

```text
- максимальный срок рассрочки: 3 месяца
- минимальный первый платёж: 30%
- минимальный ежемесячный платёж: 50 EUR
- максимальная отсрочка первого платежа: 14 дней
```

Если должник просит условия вне этих рамок:

```text
NEEDS_CUSTOMER_APPROVAL
```

Это хороший баланс между автономностью и контролем.

---

# 7. Customer Dashboard

Заказчик получает личный кабинет.

## Главный dashboard

```text
- все дела
- просроченные фактуры
- дела в коммуникации
- обещанные оплаты
- активные рассрочки
- сорванные рассрочки
- дела, готовые к юридическим действиям
- закрытые как оплаченные
- закрытые как отменённые
```

## Detail prípadu

В карточке дела:

```text
- фактура
- должник
- сумма
- due date
- текущий статус
- timeline событий
- отправленные email
- ответы должника
- результаты звонков
- promises to pay
- splátkový kalendár
- AI notes
- документы
- кнопка "Označiť ako uhradené"
- кнопка "Stop workflow"
- кнопка "Download case package"
```

---

# 8. Case statuses

Нужна полноценная state machine.

Базовый набор статусов:

```text
RECEIVED
PARSED
MANUAL_REVIEW_REQUIRED
WAITING_FOR_DUE_DATE
DUE_SOON
OVERDUE
EMAIL_REMINDER_1_SENT
EMAIL_REMINDER_2_SENT
PAYMENT_REQUEST_SENT
CALL_SCHEDULED
CALL_COMPLETED
PAYMENT_PROMISED
INSTALLMENT_REQUESTED
INSTALLMENT_PLAN_SENT
INSTALLMENT_ACTIVE
INSTALLMENT_BROKEN
FINAL_NOTICE_SENT
READY_FOR_LEGAL_ACTION
CLOSED_PAID
CLOSED_CANCELLED
CLOSED_UNRESOLVED
```

---

# 9. Если должник не платит

Система не передаёт дело в суд сама.

Она готовит пакет:

```text
- оригинальная фактура
- история контактов
- timeline действий
- отправленные email
- ответы должника
- результаты звонков
- обещания оплаты
- данные по рассрочке, если была
- summary дела
- draft дальнейшего документа
```

Финальный статус:

```text
READY_FOR_LEGAL_ACTION
```

Дальше заказчик сам решает:

```text
- подать в суд
- передать юристу
- списать долг
- продолжить вручную
```

---

# 10. Рекомендуемый стек

## Основной стек

```text
Frontend / dashboard:
  Next.js + TypeScript

UI:
  Tailwind CSS + shadcn/ui

Backend language:
  TypeScript

Database:
  PostgreSQL

ORM:
  Prisma

Workflow engine:
  Temporal

Files:
  S3-compatible storage

Email intake:
  Amazon SES

Email sending:
  Amazon SES / Postmark

AI:
  OpenAI API напрямую

Invoice parsing MVP:
  OpenAI model + Structured Outputs

Invoice parsing later:
  optional Amazon Textract

Voice calls:
  Первично пробуем Twilio (есть плагин и скиллы), если не получится -  Retell / Vapi

Bank integration:
  future plan only
```

Next.js подходит для кабинета, админки, защищённых страниц, route handlers, layouts и server/client architecture; в документации Next.js это полноценный React-фреймворк с App Router, route handlers, data fetching, authentication guides и backend-for-frontend подходом. ([nextjs.org][2])

Temporal подходит именно потому, что у проекта будут долгие процессы: ждать due date, отправлять письмо через несколько дней, ждать ответа, планировать звонок, ждать обещанную дату оплаты. Temporal описывает workflow как durable execution, что лучше обычного cron для таких цепочек. ([docs.temporal.io][3])

---

# 11. Архитектура для Codex и поддержки

Лучше делать monorepo:

```text
monorepo/
  apps/
    web/
      Next.js customer dashboard + admin panel

    worker/
      Temporal worker / background jobs

  packages/
    db/
      Prisma schema
      migrations
      db client

    ai/
      OpenAI provider
      structured output schemas
      invoice extraction
      debtor reply classification
      email generation

    documents/
      file storage
      PDF handling
      future Textract adapter

    email/
      SES/Postmark clients
      email templates
      inbound email parser

    workflows/
      collection workflow definitions
      case state machine

    shared/
      common types
      zod schemas
      constants
```

Важно: бизнес-логику не размазывать по React-компонентам.

Правильное разделение:

```text
Next.js:
  показывает dashboard
  даёт customer/admin interface
  вызывает API

Worker:
  ведёт долгие процессы
  запускает reminders
  обрабатывает письма
  вызывает OpenAI
  ставит звонки
  меняет статусы case

DB:
  источник правды

AI:
  инструмент внутри workflow, а не самостоятельный управляющий центр
```

---

# 12. AI Provider abstraction

Сразу нужно сделать абстракцию:

```ts
export interface AiProvider {
  extractInvoice(input: InvoiceExtractionInput): Promise<InvoiceExtractionResult>;
  classifyDebtorReply(input: DebtorReplyInput): Promise<DebtorReplyClassification>;
  generateDebtorEmail(input: GenerateEmailInput): Promise<GeneratedEmail>;
  summarizeCase(input: CaseSummaryInput): Promise<CaseSummary>;
}
```

Первый provider:

```text
OpenAIProvider
```

В будущем можно добавить:

```text
BedrockOpenAIProvider
ClaudeProvider
GeminiProvider
```

Но на старте — **OpenAI API напрямую**.

---

# 13. MVP scope

Для первого этапа я бы взял такой объём:

```text
1. Приём email с фактурой
2. Сохранение письма и вложений
3. Парсинг фактуры через OpenAI
4. Создание case
5. Dashboard заказчика
6. Ручное подтверждение оплаты
7. Автоматические email reminders
8. Timeline действий
9. Классификация ответов должника
10. Закрытие дела как paid/cancelled/unresolved
11. Экспорт case history
```

Не брать в MVP:

```text
- банковскую интеграцию
- полноценные AI-звонки
- сложные рассрочки
- автоматическую генерацию юридических документов
- Bedrock
- Textract как обязательный слой
```

---

# 14. Следующий этап после MVP

После MVP можно добавить:

```text
- AI calls через   Первично пробуем Twilio (есть плагин и скиллы), если не получится -  Retell / Vapi

- splátkový kalendár
- customer approval flow
- Textract для более надёжного OCR
- импорт банковских выписок
- PSD2/open banking
- генерацию финального legal package
- разные workflow templates
- роли внутри компании заказчика
- audit log
```

---

# Финальная формулировка проекта

Это **автономная SaaS-система soft-collection для малого и среднего бизнеса**, которая принимает фактуры по email, автоматически регистрирует дела, контролирует сроки оплаты, ведёт коммуникацию с должником, фиксирует ответы и обещания оплаты, уведомляет заказчика о важных событиях и готовит историю дела, если задолженность не погашена.

На первом этапе:

```text
парсинг фактур — OpenAI API
dashboard — Next.js
workflow — Temporal worker
database — PostgreSQL
email — SES/Postmark
files — S3
bank integration — future plan
Textract — future optional enhancement
```

Главное архитектурное правило: **AI помогает принимать структурированные решения внутри заранее заданного workflow, но не заменяет backend state machine и не совершает юридические действия.**

[1]: https://platform.openai.com/docs/guides/structured-outputs "Structured model outputs | OpenAI API"
[2]: https://nextjs.org/docs "Next.js Docs | Next.js"
[3]: https://docs.temporal.io/workflows "Temporal Workflow | Temporal Platform Documentation"
