import { handlePaymentCheckGet, handlePaymentCheckPost } from "@/lib/payment-check";

export const runtime = "nodejs";

export async function GET(request: Request, context: { params: Promise<{ caseId: string }> }) {
  const { caseId } = await context.params;
  return handlePaymentCheckGet(request, caseId, "NOT_PAID");
}

export async function POST(request: Request, context: { params: Promise<{ caseId: string }> }) {
  const { caseId } = await context.params;
  return handlePaymentCheckPost(request, caseId, "NOT_PAID");
}
