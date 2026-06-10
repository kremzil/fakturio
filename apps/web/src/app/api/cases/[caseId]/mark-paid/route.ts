import { NextResponse } from "next/server";
import { CASE_EVENT_TYPES } from "@fakturio/shared";
import { toDashboardCase } from "@/lib/case-data";
import { updateCaseForOrgAndEnqueueStateChange } from "@/lib/case-access";
import { httpErrorResponse, requireSession } from "@/lib/session";

export const runtime = "nodejs";

export async function POST(_: Request, context: { params: Promise<{ caseId: string }> }) {
  try {
    const { caseId } = await context.params;
    const { organizationId, userId } = await requireSession();

    const updated = await updateCaseForOrgAndEnqueueStateChange(
      caseId,
      organizationId,
      {
        status: "CLOSED_PAID",
        closedAt: new Date(),
        events: {
          create: {
            actorType: "USER",
            actorId: userId,
            type: CASE_EVENT_TYPES.paymentMarkedPaid,
            note: "Customer marked the case as paid."
          }
        }
      },
      {
        status: "CLOSED_PAID",
        idempotencyKey: `manual-paid:${caseId}`,
        source: "DASHBOARD"
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
