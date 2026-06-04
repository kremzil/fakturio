import { NextResponse } from "next/server";
import { z } from "zod";
import { CASE_EVENT_TYPES, cleanText, parseIsoDate, validateInvoiceForWorkflow } from "@fakturio/shared";
import { prisma } from "@fakturio/db";
import { toDashboardCase } from "@/lib/case-data";
import { getCaseForOrg, updateCaseForOrg } from "@/lib/case-access";
import { httpErrorResponse, requireSession } from "@/lib/session";

export const runtime = "nodejs";

const draftSchema = z.object({
  invoiceNumber: z.string().nullable().optional(),
  supplierName: z.string().nullable().optional(),
  debtorName: z.string().nullable().optional(),
  debtorEmail: z.string().email().nullable().optional().or(z.literal("")),
  amountTotal: z.coerce.number().positive().nullable().optional(),
  currency: z.string().nullable().optional(),
  dueDate: z.string().nullable().optional(),
  iban: z.string().nullable().optional(),
  variableSymbol: z.string().nullable().optional()
});

export async function PATCH(request: Request, context: { params: Promise<{ caseId: string }> }) {
  try {
    const { caseId } = await context.params;
    const { organizationId, userId } = await requireSession();
    const payload = draftSchema.parse(await request.json());

    const existing = await getCaseForOrg(caseId, organizationId, { debtor: true });

    if (!existing) {
      return NextResponse.json({ error: "Prípad neexistuje." }, { status: 404 });
    }

    const debtorName = cleanText(payload.debtorName);
    const debtorEmail = cleanText(payload.debtorEmail);
    const debtor = debtorName
      ? existing.debtorId
        ? await prisma.debtor.update({
            where: { id: existing.debtorId },
            data: { name: debtorName, email: debtorEmail }
          })
        : await prisma.debtor.create({
            data: {
              organizationId,
              name: debtorName,
              email: debtorEmail
            }
          })
      : null;

    const previousDebtorSnapshot = toRecord(existing.debtorSnapshot);
    const previousSupplierSnapshot = toRecord(existing.supplierSnapshot);
    const previousPaymentSnapshot = toRecord(existing.paymentSnapshot);
    const warnings = validateInvoiceForWorkflow({
      invoiceNumber: payload.invoiceNumber ?? existing.invoiceNumber,
      dueDate: payload.dueDate ?? existing.dueDate,
      amountTotal: payload.amountTotal ?? (existing.amountTotal ? Number(existing.amountTotal) : null),
      debtorName: debtorName ?? existing.debtor?.name ?? null,
      currency: payload.currency ?? existing.currency,
      warnings: existing.warnings
    }).warningsPatch;

    const updated = await updateCaseForOrg(
      caseId,
      organizationId,
      {
        invoiceNumber: cleanText(payload.invoiceNumber),
        dueDate: parseIsoDate(payload.dueDate),
        amountTotal: payload.amountTotal ?? null,
        currency: cleanText(payload.currency)?.toUpperCase() ?? null,
        debtor: debtor ? { connect: { id: debtor.id } } : undefined,
        supplierSnapshot: {
          ...previousSupplierSnapshot,
          name: cleanText(payload.supplierName)
        },
        debtorSnapshot: {
          ...previousDebtorSnapshot,
          name: debtorName,
          email: debtorEmail
        },
        paymentSnapshot: {
          ...previousPaymentSnapshot,
          iban: cleanText(payload.iban),
          variableSymbol: cleanText(payload.variableSymbol)
        },
        warnings: warnings ?? existing.warnings,
        events: {
          create: {
            actorType: "USER",
            actorId: userId,
            type: CASE_EVENT_TYPES.statusChanged,
            note: "Invoice review draft saved."
          }
        }
      },
      {
        debtor: true,
        invoiceDocuments: { orderBy: { createdAt: "desc" }, take: 1 },
        events: { orderBy: { createdAt: "desc" }, take: 6 }
      }
    );

    if (!updated) {
      return NextResponse.json({ error: "Prípad neexistuje." }, { status: 404 });
    }

    return NextResponse.json({ case: toDashboardCase(updated) });
  } catch (error) {
    return httpErrorResponse(error);
  }
}

function toRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}
