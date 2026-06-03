import type { Case, CaseEvent, Debtor, InvoiceDocument } from "@prisma/client";
import { ensureLocalBootstrap, prisma } from "@fakturio/db";

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
  warnings: string[];
  confidence: number | null;
  documentName: string | null;
  events: Array<{ id: string; type: string; note: string | null; createdAt: string }>;
};

export async function getDashboardCases(): Promise<DashboardCase[]> {
  try {
    await ensureLocalBootstrap();
    const cases = await prisma.case.findMany({
      orderBy: { createdAt: "desc" },
      take: 25,
      include: {
        debtor: true,
        invoiceDocuments: { orderBy: { createdAt: "desc" }, take: 1 },
        events: { orderBy: { createdAt: "desc" }, take: 6 }
      }
    });

    return cases.map(toDashboardCase);
  } catch {
    return demoCases;
  }
}

export async function getDashboardCaseById(caseId: string): Promise<DashboardCase | null> {
  const item = await prisma.case.findUnique({
    where: { id: caseId },
    include: {
      debtor: true,
      invoiceDocuments: { orderBy: { createdAt: "desc" }, take: 1 },
      events: { orderBy: { createdAt: "desc" }, take: 6 }
    }
  });

  return item ? toDashboardCase(item) : null;
}

export const demoCases: DashboardCase[] = [
  {
    id: "demo-1",
    status: "WAITING_FOR_DUE_DATE",
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
    warnings: [],
    confidence: 0.98,
    documentName: "faktura-52606-00029.pdf",
    events: [
      { id: "e1", type: "INVOICE_PARSED", note: "OpenAI extraction completed.", createdAt: new Date().toISOString() },
      { id: "e2", type: "WORKFLOW_STARTED", note: "Waiting for due date.", createdAt: new Date().toISOString() }
    ]
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
    warnings: ["Demo režim: spustite Docker infra a migrácie pre reálne dáta."],
    confidence: 0,
    documentName: null,
    events: []
  }
];

export function toDashboardCase(
  item: Case & {
    debtor?: Debtor | null;
    invoiceDocuments?: InvoiceDocument[];
    events?: CaseEvent[];
  }
): DashboardCase {
  const debtorSnapshot = asRecord(item.debtorSnapshot);
  const supplierSnapshot = asRecord(item.supplierSnapshot);
  const paymentSnapshot = asRecord(item.paymentSnapshot);

  return {
    id: item.id,
    status: item.status,
    sourceType: item.sourceType,
    invoiceNumber: item.invoiceNumber,
    supplierName: stringFromRecord(supplierSnapshot, "name"),
    debtorName: item.debtor?.name ?? stringFromRecord(debtorSnapshot, "name"),
    debtorEmail: item.debtor?.email ?? stringFromRecord(debtorSnapshot, "email"),
    amountTotal: item.amountTotal ? Number(item.amountTotal) : null,
    currency: item.currency,
    dueDate: item.dueDate?.toISOString().slice(0, 10) ?? null,
    iban: stringFromRecord(paymentSnapshot, "iban"),
    variableSymbol: stringFromRecord(paymentSnapshot, "variableSymbol"),
    warnings: item.warnings,
    confidence: item.aiConfidence,
    documentName: item.invoiceDocuments?.[0]?.originalName ?? null,
    events: (item.events ?? []).map((event) => ({
      id: event.id,
      type: event.type,
      note: event.note,
      createdAt: event.createdAt.toISOString()
    }))
  };
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function stringFromRecord(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}
