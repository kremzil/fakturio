import { NextResponse } from "next/server";
import { getDashboardDebtorById } from "@/lib/debtor-data";
import { httpErrorResponse, requireSession } from "@/lib/session";

export const runtime = "nodejs";

export async function GET(
  _: Request,
  context: { params: Promise<{ debtorId: string }> }
) {
  try {
    const { debtorId } = await context.params;
    const { organizationId } = await requireSession();
    const debtor = await getDashboardDebtorById(debtorId, organizationId);

    if (!debtor) {
      return NextResponse.json({ error: "Dlžník neexistuje." }, { status: 404 });
    }

    return NextResponse.json({ debtor });
  } catch (error) {
    return httpErrorResponse(error);
  }
}
