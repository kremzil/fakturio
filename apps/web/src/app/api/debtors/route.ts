import { NextResponse } from "next/server";
import { getDashboardDebtors } from "@/lib/debtor-data";
import { httpErrorResponse, requireSession } from "@/lib/session";

export const runtime = "nodejs";

export async function GET() {
  try {
    const { organizationId } = await requireSession();
    const debtors = await getDashboardDebtors(organizationId);
    return NextResponse.json({ debtors });
  } catch (error) {
    return httpErrorResponse(error);
  }
}
