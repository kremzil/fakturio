import { CASE_EVENT_TYPES, validateInvoiceForWorkflow } from "@fakturio/shared";
import { prisma } from "@fakturio/db";
import { requestCaseWorkflowStart } from "./workflow-client";

export type ConfirmCaseResult =
  | { outcome: "APPLIED" | "NOOP"; caseId: string; organizationId: string }
  | { outcome: "NOT_FOUND" }
  | { outcome: "CONFLICT"; message: string }
  | { outcome: "VALIDATION_FAILED"; errors: string[] };

export async function confirmCaseForWorkflow(input: {
  caseId: string;
  organizationId: string;
  actorType: "USER" | "EMAIL_PROVIDER";
  actorId?: string | null;
  note?: string;
}): Promise<ConfirmCaseResult> {
  const result = await prisma.$transaction(async (tx) => {
    const existing = await tx.case.findFirst({
      where: { id: input.caseId, organizationId: input.organizationId },
      include: { debtor: true }
    });

    if (!existing) {
      return { outcome: "NOT_FOUND" as const };
    }

    if (existing.confirmedAt && existing.status === "WAITING_FOR_DUE_DATE") {
      return {
        outcome: "NOOP" as const,
        caseId: existing.id,
        organizationId: existing.organizationId
      };
    }

    if (
      existing.confirmedAt ||
      !["RECEIVED", "PARSED", "MANUAL_REVIEW_REQUIRED"].includes(existing.status)
    ) {
      return {
        outcome: "CONFLICT" as const,
        message: "Tento prípad už nemožno potvrdiť."
      };
    }

    const validation = validateInvoiceForWorkflow({
      invoiceNumber: existing.invoiceNumber,
      dueDate: existing.dueDate,
      amountTotal: existing.amountTotal ? Number(existing.amountTotal) : null,
      debtorName: existing.debtor?.name ?? null,
      currency: existing.currency,
      warnings: existing.warnings
    });

    if (validation.errors.length > 0) {
      return {
        outcome: "VALIDATION_FAILED" as const,
        errors: validation.errors
      };
    }

    await tx.case.update({
      where: { id: existing.id },
      data: {
        status: "WAITING_FOR_DUE_DATE",
        currency: existing.currency ?? validation.currencyPatch,
        warnings: validation.warningsPatch ?? existing.warnings,
        confirmedByUserId: input.actorType === "USER" ? input.actorId : null,
        confirmedAt: new Date(),
        events: {
          create: {
            actorType: input.actorType,
            actorId: input.actorType === "USER" ? input.actorId : null,
            type: CASE_EVENT_TYPES.statusChanged,
            note: input.note ?? "Case confirmed and ready for payment monitoring."
          }
        }
      }
    });

    return {
      outcome: "APPLIED" as const,
      caseId: existing.id,
      organizationId: existing.organizationId
    };
  });

  if (result.outcome === "APPLIED") {
    await requestCaseWorkflowStart({
      caseId: result.caseId,
      organizationId: result.organizationId
    });
  }

  return result;
}
