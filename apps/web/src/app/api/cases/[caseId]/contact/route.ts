import { NextResponse } from "next/server";
import { z } from "zod";
import {
  CaseActionConflictError
} from "@/lib/case-actions";
import { updateDebtorEmailForOrg } from "@/lib/case-contact";
import { httpErrorResponse, requireSession } from "@/lib/session";

export const runtime = "nodejs";

const contactSchema = z.object({
  debtorEmail: z.string().email()
});

export async function PATCH(
  request: Request,
  context: { params: Promise<{ caseId: string }> }
) {
  try {
    const { caseId } = await context.params;
    const { organizationId, userId } = await requireSession();
    const payload = contactSchema.parse(await request.json());
    const result = await updateDebtorEmailForOrg({
      caseId,
      organizationId,
      userId,
      email: payload.debtorEmail.trim().toLowerCase()
    });

    if (!result) {
      return NextResponse.json({ error: "Prípad neexistuje." }, { status: 404 });
    }
    return NextResponse.json({ case: result });
  } catch (error) {
    if (error instanceof CaseActionConflictError) {
      return NextResponse.json({ error: error.message }, { status: 409 });
    }
    return httpErrorResponse(error);
  }
}
