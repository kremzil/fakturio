import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import { z } from "zod";
import { CustomerEmailAssistantService } from "@fakturio/intake";
import { prisma } from "@fakturio/db";
import {
  createCaseClarificationAddress,
  requireInboundReplyTokenSecret
} from "@fakturio/shared";
import type { InboundEmail } from "@fakturio/email";
import { getCaseForOrg } from "@/lib/case-access";
import { dashboardCaseInclude, toDashboardCase } from "@/lib/case-data";
import { httpErrorResponse, requireSession } from "@/lib/session";

export const runtime = "nodejs";

const assistantMessageSchema = z.object({
  message: z.string().trim().min(2).max(4000)
});

export async function POST(
  request: Request,
  context: { params: Promise<{ caseId: string }> }
) {
  try {
    const { caseId } = await context.params;
    const { organizationId, userId } = await requireSession();
    const { message } = assistantMessageSchema.parse(await request.json());

    const collectionCase = await getCaseForOrg(caseId, organizationId);
    if (!collectionCase) {
      return NextResponse.json({ error: "Prípad neexistuje." }, { status: 404 });
    }

    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { email: true, name: true }
    });
    const from = user?.email ?? "dashboard@fakturio.local";
    const providerId = `dashboard-${caseId}-${randomUUID()}`;
    const clarifyAddress = createCaseClarificationAddress(
      { caseId, domain: inboundReplyDomain() },
      requireInboundReplyTokenSecret()
    );
    const inbound: InboundEmail = {
      provider: "dashboard",
      providerId,
      messageId: `<${providerId}@dashboard.fakturio.local>`,
      inReplyTo: null,
      references: [],
      autoSubmitted: null,
      precedence: null,
      from,
      to: [clarifyAddress],
      cc: [],
      subject: "Dashboard assistant",
      textBody: message,
      htmlBody: null,
      attachments: [],
      raw: {
        source: "dashboard",
        userId,
        organizationId
      }
    };

    const result = await new CustomerEmailAssistantService().process(
      inbound,
      undefined,
      { sendReply: false }
    );

    if (!result || result.caseId !== caseId || result.organizationId !== organizationId) {
      return NextResponse.json(
        { error: "Správu sa nepodarilo priradiť k prípadu." },
        { status: 409 }
      );
    }

    const updated = await getCaseForOrg(caseId, organizationId, dashboardCaseInclude);
    if (!updated) {
      return NextResponse.json({ error: "Prípad neexistuje." }, { status: 404 });
    }

    return NextResponse.json({
      case: toDashboardCase(updated),
      assistant: {
        intent: result.intent,
        reply: result.assistantReply,
        appliedFields: result.appliedFields,
        stillMissing: result.stillMissing
      }
    });
  } catch (error) {
    return httpErrorResponse(error);
  }
}

function inboundReplyDomain(): string {
  return (
    process.env.INBOUND_REPLY_DOMAIN ||
    process.env.SES_INBOUND_DOMAIN ||
    "fakturio.test"
  );
}
