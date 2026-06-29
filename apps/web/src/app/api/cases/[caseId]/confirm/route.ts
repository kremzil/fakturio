import { NextResponse } from "next/server";
import { dashboardCaseInclude, toDashboardCase } from "@/lib/case-data";
import { getCaseForOrg } from "@/lib/case-access";
import { httpErrorResponse, requireSession } from "@/lib/session";
import { confirmCaseForWorkflow } from "@/lib/case-confirm";

export const runtime = "nodejs";

export async function POST(_: Request, context: { params: Promise<{ caseId: string }> }) {
  try {
    const { caseId } = await context.params;
    const { organizationId, userId } = await requireSession();

    const existing = await getCaseForOrg(caseId, organizationId, { debtor: true });

    if (!existing) {
      return NextResponse.json({ error: "Prípad neexistuje." }, { status: 404 });
    }

    const result = await confirmCaseForWorkflow({
      caseId,
      organizationId,
      actorType: "USER",
      actorId: userId
    });

    if (result.outcome === "CONFLICT") {
      return NextResponse.json(
        { error: result.message },
        { status: 409 }
      );
    }
    if (result.outcome === "VALIDATION_FAILED") {
      return NextResponse.json({ errors: result.errors }, { status: 422 });
    }
    if (result.outcome === "NOT_FOUND") {
      return NextResponse.json({ error: "Prípad neexistuje." }, { status: 404 });
    }

    const updated = await getCaseForOrg(caseId, organizationId, dashboardCaseInclude);

    return NextResponse.json({ case: toDashboardCase(updated!) });
  } catch (error) {
    return httpErrorResponse(error);
  }
}
