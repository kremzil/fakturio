import {
  handleCaseConfirmLinkGet,
  handleCaseConfirmLinkPost
} from "@/lib/case-confirm-link";

export const runtime = "nodejs";

export async function GET(
  request: Request,
  context: { params: Promise<{ caseId: string }> }
) {
  const { caseId } = await context.params;
  return handleCaseConfirmLinkGet(request, caseId);
}

export async function POST(
  request: Request,
  context: { params: Promise<{ caseId: string }> }
) {
  const { caseId } = await context.params;
  return handleCaseConfirmLinkPost(request, caseId);
}
