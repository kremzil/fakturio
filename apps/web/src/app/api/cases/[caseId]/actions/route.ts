import { NextResponse } from "next/server";
import { z } from "zod";
import {
  CaseActionConflictError,
  MANUAL_CASE_ACTIONS,
  applyManualCaseAction
} from "@/lib/case-actions";
import { httpErrorResponse, requireSession } from "@/lib/session";

export const runtime = "nodejs";

const actionSchema = z.object({
  action: z.enum(MANUAL_CASE_ACTIONS)
});

export async function POST(
  request: Request,
  context: { params: Promise<{ caseId: string }> }
) {
  try {
    const { caseId } = await context.params;
    const { organizationId, userId } = await requireSession();
    const { action } = actionSchema.parse(await request.json());
    const result = await applyManualCaseAction({
      caseId,
      organizationId,
      userId,
      action
    });

    if (!result) {
      return NextResponse.json(
        { error: "Prípad neexistuje." },
        { status: 404 }
      );
    }
    return NextResponse.json({ case: result });
  } catch (error) {
    if (error instanceof CaseActionConflictError) {
      return NextResponse.json({ error: error.message }, { status: 409 });
    }
    return httpErrorResponse(error);
  }
}
