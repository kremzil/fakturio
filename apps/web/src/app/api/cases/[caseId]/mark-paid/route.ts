import { NextResponse } from "next/server";
import { CASE_EVENT_TYPES } from "@fakturio/shared";
import { ensureLocalBootstrap, prisma } from "@fakturio/db";
import { toDashboardCase } from "@/lib/case-data";

export const runtime = "nodejs";

export async function POST(_: Request, context: { params: Promise<{ caseId: string }> }) {
  const { caseId } = await context.params;
  const { user } = await ensureLocalBootstrap();

  const updated = await prisma.case.update({
    where: { id: caseId },
    data: {
      status: "CLOSED_PAID",
      closedAt: new Date(),
      events: {
        create: {
          actorType: "USER",
          actorId: user.id,
          type: CASE_EVENT_TYPES.paymentMarkedPaid,
          note: "Customer marked the case as paid."
        }
      }
    },
    include: {
      debtor: true,
      invoiceDocuments: { orderBy: { createdAt: "desc" }, take: 1 },
      events: { orderBy: { createdAt: "desc" }, take: 6 }
    }
  });

  return NextResponse.json({ case: toDashboardCase(updated) });
}
