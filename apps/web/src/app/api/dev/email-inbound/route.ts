import { NextResponse } from "next/server";
import { z } from "zod";
import { ensureLocalBootstrap } from "@fakturio/db";
import { FixtureEmailProvider } from "@fakturio/email";
import {
  DebtorReplyService,
  InvoiceIntakeService,
  resolveOrganizationForInboundEmail
} from "@fakturio/intake";
import { getDashboardCaseById } from "@/lib/case-data";

export const runtime = "nodejs";

const inboundEmailFixtureSchema = z.object({
  providerId: z.string().optional(),
  messageId: z.string().nullable().default(null),
  inReplyTo: z.string().nullable().default(null),
  references: z.array(z.string()).default([]),
  autoSubmitted: z.string().nullable().default(null),
  precedence: z.string().nullable().default(null),
  from: z.string().email().default("sender@example.com"),
  to: z.array(z.string()).default(["invoices@fakturio.local"]),
  cc: z.array(z.string()).default([]),
  subject: z.string().nullable().default(null),
  textBody: z.string().nullable().default(null),
  htmlBody: z.string().nullable().default(null),
  attachments: z
    .array(
      z.object({
        fileName: z.string(),
        mimeType: z.string(),
        base64: z.string()
      })
    )
    .default([])
});

export async function POST(request: Request) {
  if (process.env.NODE_ENV === "production") {
    return NextResponse.json({ error: "Dev email intake endpoint is disabled in production." }, { status: 404 });
  }

  const payload = inboundEmailFixtureSchema.parse(await request.json());
  const emailProvider = new FixtureEmailProvider();
  const email = await emailProvider.parseInbound({
    ...payload,
    attachments: payload.attachments.map((attachment) => ({
      fileName: attachment.fileName,
      mimeType: attachment.mimeType,
      bytes: Uint8Array.from(Buffer.from(attachment.base64, "base64"))
    }))
  });

  const reply = await new DebtorReplyService().process(email);
  if (reply) {
    const collectionCase = await getDashboardCaseById(
      reply.caseId,
      reply.organizationId
    );
    return NextResponse.json({ kind: "DEBTOR_REPLY", reply, case: collectionCase });
  }

  const { organization } = await ensureLocalBootstrap();
  const route = await resolveOrganizationForInboundEmail(email);
  const organizationId = route?.organizationId ?? organization.id;
  const result = await new InvoiceIntakeService().createFromEmail({
    organizationId,
    email
  });
  const cases = await Promise.all(result.cases.map((item) => getDashboardCaseById(item.caseId, organizationId)));

  return NextResponse.json({
    kind: "INVOICE_INTAKE",
    cases: cases.filter(Boolean),
    route,
    skippedAttachments: result.skippedAttachments
  });
}
