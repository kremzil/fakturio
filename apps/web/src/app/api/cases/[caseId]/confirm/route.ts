import { NextResponse } from "next/server";
import { CASE_EVENT_TYPES, validateInvoiceForWorkflow } from "@fakturio/shared";
import { toDashboardCase } from "@/lib/case-data";
import { getCaseForOrg, updateCaseForOrg } from "@/lib/case-access";
import { httpErrorResponse, requireSession } from "@/lib/session";
import { requestCaseWorkflowStart } from "@/lib/workflow-client";

export const runtime = "nodejs";

export async function POST(_: Request, context: { params: Promise<{ caseId: string }> }) {
  try {
    const { caseId } = await context.params;
    const { organizationId, userId } = await requireSession();

    const existing = await getCaseForOrg(caseId, organizationId, { debtor: true });

    if (!existing) {
      return NextResponse.json({ error: "Prípad neexistuje." }, { status: 404 });
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
      return NextResponse.json({ errors: validation.errors }, { status: 422 });
    }

    const updated = await updateCaseForOrg(
      caseId,
      organizationId,
      {
        status: "WAITING_FOR_DUE_DATE",
        currency: existing.currency ?? validation.currencyPatch,
        warnings: validation.warningsPatch ?? existing.warnings,
        confirmedByUserId: userId,
        confirmedAt: new Date(),
        events: {
          create: {
            actorType: "USER",
            actorId: userId,
            type: CASE_EVENT_TYPES.statusChanged,
            note: "Case confirmed and ready for payment monitoring."
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

    await requestCaseWorkflowStart({ caseId: updated.id, organizationId: updated.organizationId });

    return NextResponse.json({ case: toDashboardCase(updated) });
  } catch (error) {
    return httpErrorResponse(error);
  }
}
