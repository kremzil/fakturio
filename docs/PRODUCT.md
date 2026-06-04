# Product Brief

FAKTURIO is an autonomous soft-collection system for small and medium businesses. A customer sends an invoice to a debtor and registers it in FAKTURIO. The system creates a case, monitors due date, sends reminders, classifies debtor replies, tracks promises and disputes, and keeps a complete timeline.

## Product Boundary

The system may automate standard payment-control communication. It must not perform legal actions, threaten debtors, approve discounts, change debt amounts, or accept non-standard installment terms without customer approval.

## Core Layers

- Invoice Intake: email or upload, original file storage, AI extraction, validation, manual review.
- Payment Monitoring: wait until due date, ask the customer whether payment arrived, close paid cases or continue collection when unpaid.
- Debtor Communication: predefined reminder workflow, reply classification, timeline.
- Customer Dashboard: cases, overdue invoices, promises, communications, package export.

## MVP Scope On Target Stack

- Upload invoice or receive it through email intake and parse it through OpenAI.
- Create a `Case` and `InvoiceDocument`.
- Resolve the customer account from inbound email aliases.
- Match repeat debtors/counterparties inside the customer organization.
- Review parsed fields.
- Confirm case for payment monitoring.
- Wait until invoice due date and email the customer with paid/not-paid actions.
- Close paid cases or mark unpaid cases as overdue.
- Store all actions as `CaseEvent`.
- Provide provider boundaries for S3, SES and Temporal.

## Later Scope

- Full reminder workflow.
- Installment plans.
- Voice-call adapter, Twilio first.
- Legal package export.
- Textract and bank integration as optional future modules.
