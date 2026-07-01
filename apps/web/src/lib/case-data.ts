import type { Prisma } from "@prisma/client";
import { getCaseForOrg, listCasesForOrg } from "./case-access";

export const dashboardCaseSummaryInclude = {
  debtor: true,
  customer: true,
  invoiceDocuments: { orderBy: { createdAt: "desc" }, take: 1 },
  _count: { select: { events: true, communications: true } },
  paymentPromises: { orderBy: { createdAt: "desc" }, take: 1 },
  paymentChecks: { orderBy: { createdAt: "desc" }, take: 1 },
  installmentPlans: {
    orderBy: { createdAt: "desc" },
    take: 1,
    include: { payments: { orderBy: { sequence: "asc" } } }
  }
} satisfies Prisma.CaseInclude;

export const dashboardCaseInclude = {
  ...dashboardCaseSummaryInclude,
  events: { orderBy: { createdAt: "desc" } },
  communications: {
    orderBy: { createdAt: "desc" },
    include: { attachments: true }
  },
  paymentPromises: { orderBy: { createdAt: "desc" } },
  paymentChecks: { orderBy: { createdAt: "desc" } },
  installmentPlans: {
    orderBy: { createdAt: "desc" },
    include: { payments: { orderBy: { sequence: "asc" } } }
  }
} satisfies Prisma.CaseInclude;

type DashboardCaseSummaryRecord = Prisma.CaseGetPayload<{
  include: typeof dashboardCaseSummaryInclude;
}>;

type DashboardCaseRecord = Prisma.CaseGetPayload<{
  include: typeof dashboardCaseInclude;
}>;

export type DashboardEvent = {
  id: string;
  type: string;
  actorType: string;
  note: string | null;
  createdAt: string;
  payload?: unknown | null;
};

export type DashboardCommunication = {
  id: string;
  direction: string;
  status: string;
  subject: string | null;
  fromAddress: string | null;
  toAddress: string | null;
  textBody: string | null;
  createdAt: string;
  sentAt: string | null;
  receivedAt: string | null;
  attachmentCount: number;
  kind?: string | null;
  aiIntent?: string | null;
  aiSummary?: string | null;
};

export type DashboardCase = {
  id: string;
  status: string;
  sourceType: "UPLOAD" | "EMAIL";
  invoiceNumber: string | null;
  supplierName: string | null;
  debtorName: string | null;
  debtorEmail: string | null;
  amountTotal: number | null;
  currency: string | null;
  dueDate: string | null;
  iban: string | null;
  variableSymbol: string | null;
  subjectNote: string | null;
  warnings: string[];
  confidence: number | null;
  documentName: string | null;
  workflowId: string | null;
  confirmedAt: string | null;
  nextActionAt: string | null;
  automationPausedAt: string | null;
  automationPauseReason: string | null;
  closedAt: string | null;
  createdAt: string;
  updatedAt: string;
  detailsLoaded: boolean;
  eventCount: number;
  communicationCount: number;
  events: DashboardEvent[];
  communications: DashboardCommunication[];
  paymentPromises: Array<{
    id: string;
    promisedDate: string;
    amount: number | null;
    currency: string | null;
    note: string | null;
    fulfilledAt: string | null;
    brokenAt: string | null;
  }>;
  paymentChecks: Array<{
    id: string;
    reason: string;
    status: string;
    sequence: number;
    expectedAmount: number | null;
    currency: string | null;
    expiresAt: string;
    resolvedAt: string | null;
  }>;
  installmentPlans: Array<{
    id: string;
    status: string;
    totalAmount: number;
    currency: string;
    proposedAt: string;
    acceptedAt: string | null;
    payments: Array<{
      id: string;
      sequence: number;
      amount: number;
      dueDate: string;
      status: string;
      paidAt: string | null;
      missedAt: string | null;
    }>;
  }>;
};

export async function getDashboardCases(
  organizationId: string
): Promise<DashboardCase[]> {
  try {
    const cases = await listCasesForOrg(organizationId, {
      orderBy: { createdAt: "desc" },
      take: 50,
      include: dashboardCaseSummaryInclude
    });

    return cases.map(toDashboardCase);
  } catch (error) {
    if (process.env.NODE_ENV === "production") {
      throw error;
    }
    return demoCases;
  }
}

export async function getDashboardCaseById(
  caseId: string,
  organizationId: string
): Promise<DashboardCase | null> {
  const item = await getCaseForOrg(
    caseId,
    organizationId,
    dashboardCaseInclude
  );
  return item ? toDashboardCase(item) : null;
}

export function toDashboardCase(
  item: DashboardCaseRecord | DashboardCaseSummaryRecord
): DashboardCase {
  const detail = item as DashboardCaseRecord;
  const detailsLoaded = Array.isArray(detail.events);
  const debtorSnapshot = asRecord(item.debtorSnapshot);
  const supplierSnapshot = asRecord(item.supplierSnapshot);
  const paymentSnapshot = asRecord(item.paymentSnapshot);

  return {
    id: item.id,
    status: item.status,
    sourceType: item.sourceType,
    invoiceNumber: item.invoiceNumber,
    supplierName:
      item.customer?.name ?? stringFromRecord(supplierSnapshot, "name"),
    debtorName:
      item.debtor?.name ?? stringFromRecord(debtorSnapshot, "name"),
    debtorEmail:
      item.debtor?.email ?? stringFromRecord(debtorSnapshot, "email"),
    amountTotal: decimalNumber(item.amountTotal),
    currency: item.currency,
    dueDate: isoDate(item.dueDate),
    iban: stringFromRecord(paymentSnapshot, "iban"),
    variableSymbol: stringFromRecord(paymentSnapshot, "variableSymbol"),
    subjectNote: item.subjectNote,
    warnings: item.warnings,
    confidence: item.aiConfidence,
    documentName: item.invoiceDocuments[0]?.originalName ?? null,
    workflowId: item.workflowId,
    confirmedAt: item.confirmedAt?.toISOString() ?? null,
    nextActionAt: item.nextActionAt?.toISOString() ?? null,
    automationPausedAt: item.automationPausedAt?.toISOString() ?? null,
    automationPauseReason: item.automationPauseReason,
    closedAt: item.closedAt?.toISOString() ?? null,
    createdAt: item.createdAt.toISOString(),
    updatedAt: item.updatedAt.toISOString(),
    detailsLoaded,
    eventCount: item._count.events,
    communicationCount: item._count.communications,
    events: (detail.events ?? []).map((event) => ({
      id: event.id,
      type: event.type,
      actorType: event.actorType,
      note: event.note,
      createdAt: event.createdAt.toISOString(),
      payload: event.payload ?? null
    })),
    communications: (detail.communications ?? []).map((communication) => ({
      id: communication.id,
      direction: communication.direction,
      status: communication.status,
      subject: communication.subject,
      fromAddress: communication.fromAddress,
      toAddress: communication.toAddress,
      textBody: communication.textBody,
      createdAt: communication.createdAt.toISOString(),
      sentAt: communication.sentAt?.toISOString() ?? null,
      receivedAt: communication.receivedAt?.toISOString() ?? null,
      attachmentCount: communication.attachments.length,
      kind: stringFromRecord(asRecord(communication.rawPayload), "kind"),
      aiIntent: stringFromRecord(asRecord(communication.aiClassification), "intent"),
      aiSummary: stringFromRecord(asRecord(communication.aiClassification), "summary")
    })),
    paymentPromises: item.paymentPromises.map((promise) => ({
      id: promise.id,
      promisedDate: promise.promisedDate.toISOString(),
      amount: decimalNumber(promise.amount),
      currency: promise.currency,
      note: promise.note,
      fulfilledAt: promise.fulfilledAt?.toISOString() ?? null,
      brokenAt: promise.brokenAt?.toISOString() ?? null
    })),
    paymentChecks: item.paymentChecks.map((check) => ({
      id: check.id,
      reason: check.reason,
      status: check.status,
      sequence: check.sequence,
      expectedAmount: decimalNumber(check.expectedAmount),
      currency: check.currency,
      expiresAt: check.expiresAt.toISOString(),
      resolvedAt: check.resolvedAt?.toISOString() ?? null
    })),
    installmentPlans: item.installmentPlans.map((plan) => ({
      id: plan.id,
      status: plan.status,
      totalAmount: Number(plan.totalAmount),
      currency: plan.currency,
      proposedAt: plan.proposedAt.toISOString(),
      acceptedAt: plan.acceptedAt?.toISOString() ?? null,
      payments: plan.payments.map((payment) => ({
        id: payment.id,
        sequence: payment.sequence,
        amount: Number(payment.amount),
        dueDate: payment.dueDate.toISOString(),
        status: payment.status,
        paidAt: payment.paidAt?.toISOString() ?? null,
        missedAt: payment.missedAt?.toISOString() ?? null
      }))
    }))
  };
}

const demoNow = new Date().toISOString();

export const demoCases: DashboardCase[] = [
  {
    id: "demo-1",
    status: "PAYMENT_PROMISED",
    sourceType: "UPLOAD",
    invoiceNumber: "52606 00029",
    supplierName: "Dodávateľ s.r.o.",
    debtorName: "Július Bačo",
    debtorEmail: "ap@example.com",
    amountTotal: 64.73,
    currency: "EUR",
    dueDate: "2026-06-02",
    iban: "SK3112000000198742637541",
    variableSymbol: "5260600029",
    subjectNote: "Webhosting",
    warnings: [],
    confidence: 0.98,
    documentName: "faktura-52606-00029.pdf",
    workflowId: "case-demo-1",
    confirmedAt: demoNow,
    nextActionAt: "2026-06-17T00:00:00.000Z",
    automationPausedAt: null,
    automationPauseReason: null,
    closedAt: null,
    createdAt: demoNow,
    updatedAt: demoNow,
    detailsLoaded: true,
    eventCount: 2,
    communicationCount: 1,
    events: [
      {
        id: "e1",
        type: "PAYMENT_PROMISE_CREATED",
        actorType: "WORKFLOW",
        note: "Dlžník prisľúbil úhradu do 17. 6. 2026.",
        createdAt: demoNow
      },
      {
        id: "e2",
        type: "EMAIL_SENT",
        actorType: "WORKFLOW",
        note: "Prvá pripomienka bola odoslaná.",
        createdAt: demoNow
      }
    ],
    communications: [
      {
        id: "c1",
        direction: "INBOUND",
        status: "RECEIVED",
        subject: "Re: Faktúra 52606 00029",
        fromAddress: "ap@example.com",
        toAddress: "reply@example.com",
        textBody: "Faktúru uhradíme do 17. júna.",
        createdAt: demoNow,
        sentAt: null,
        receivedAt: demoNow,
        attachmentCount: 0
      }
    ],
    paymentPromises: [
      {
        id: "p1",
        promisedDate: "2026-06-17T00:00:00.000Z",
        amount: 64.73,
        currency: "EUR",
        note: "Dlžník prisľúbil úhradu.",
        fulfilledAt: null,
        brokenAt: null
      }
    ],
    paymentChecks: [],
    installmentPlans: []
  },
  {
    id: "demo-2",
    status: "MANUAL_REVIEW_REQUIRED",
    sourceType: "EMAIL",
    invoiceNumber: null,
    supplierName: null,
    debtorName: null,
    debtorEmail: null,
    amountTotal: null,
    currency: null,
    dueDate: null,
    iban: null,
    variableSymbol: null,
    subjectNote: null,
    warnings: ["Skontrolujte číslo faktúry a dlžníka."],
    confidence: 0.41,
    documentName: "incoming-invoice.pdf",
    workflowId: null,
    confirmedAt: null,
    nextActionAt: null,
    automationPausedAt: demoNow,
    automationPauseReason: "MANUAL_REVIEW_REQUIRED",
    closedAt: null,
    createdAt: demoNow,
    updatedAt: demoNow,
    detailsLoaded: true,
    eventCount: 0,
    communicationCount: 0,
    events: [],
    communications: [],
    paymentPromises: [],
    paymentChecks: [],
    installmentPlans: []
  }
];

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function stringFromRecord(
  record: Record<string, unknown>,
  key: string
): string | null {
  const value = record[key];
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function decimalNumber(value: { toString(): string } | null): number | null {
  return value === null ? null : Number(value);
}

function isoDate(value: Date | null): string | null {
  return value?.toISOString().slice(0, 10) ?? null;
}
