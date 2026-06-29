import { timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { z } from "zod";
import { SesEmailProvider } from "@fakturio/email";
import { processInboundEmail } from "@fakturio/intake";

export const runtime = "nodejs";

const sesInboundSchema = z.object({
  providerId: z.string().optional(),
  raw: z.string().min(1),
  contentEncoding: z.enum(["utf8", "base64"]).default("base64")
});

export async function POST(request: Request) {
  if (!isAuthorized(request)) {
    return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  }

  const payload = sesInboundSchema.parse(await request.json());
  const email = await new SesEmailProvider({
    region: process.env.AWS_REGION || "eu-central-1",
    accessKeyId: process.env.SES_AWS_ACCESS_KEY_ID || undefined,
    secretAccessKey: process.env.SES_AWS_SECRET_ACCESS_KEY || undefined
  }).parseInbound({
    ...payload,
    contentEncoding:
      payload.contentEncoding === "base64" ? "base64" : undefined
  });

  const result = await processInboundEmail(email);
  if (result.kind === "CUSTOMER_ASSISTANT") {
    return NextResponse.json(
      {
        kind: "CUSTOMER_ASSISTANT",
        caseId: result.assistant.caseId,
        duplicate: result.assistant.duplicate,
        appliedFields: result.assistant.appliedFields,
        stillMissing: result.assistant.stillMissing,
        intent: result.assistant.intent,
        replySent: result.assistant.replySent
      },
      { status: 202 }
    );
  }

  if (result.kind === "DEBTOR_REPLY") {
    return NextResponse.json(
      {
        kind: "DEBTOR_REPLY",
        caseId: result.reply.caseId,
        duplicate: result.reply.duplicate
      },
      { status: 202 }
    );
  }

  if (result.kind === "UNMATCHED") {
    return NextResponse.json(
      { error: "No active organization email route matched the recipients." },
      { status: 422 }
    );
  }

  return NextResponse.json(
    {
      kind: "INVOICE_INTAKE",
      caseIds: result.intake.cases.map((item) => item.caseId),
      skippedAttachments: result.intake.skippedAttachments
    },
    { status: 202 }
  );
}

function isAuthorized(request: Request): boolean {
  const expected = process.env.INBOUND_EMAIL_WEBHOOK_SECRET;
  if (!expected || expected.length < 32) {
    if (process.env.NODE_ENV === "production") {
      throw new Error(
        "INBOUND_EMAIL_WEBHOOK_SECRET must contain at least 32 characters."
      );
    }
    return false;
  }

  const authorization = request.headers.get("authorization");
  const provided = authorization?.startsWith("Bearer ")
    ? authorization.slice("Bearer ".length)
    : "";
  const expectedBytes = Buffer.from(expected);
  const providedBytes = Buffer.from(provided);
  return (
    expectedBytes.length === providedBytes.length &&
    timingSafeEqual(expectedBytes, providedBytes)
  );
}
