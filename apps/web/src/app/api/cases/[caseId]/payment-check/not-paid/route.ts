import { NextResponse } from "next/server";
import { CASE_EVENT_TYPES } from "@fakturio/shared";
import { prisma } from "@fakturio/db";

export const runtime = "nodejs";

export async function GET(_: Request, context: { params: Promise<{ caseId: string }> }) {
  return markPaymentNotReceived(context);
}

export async function POST(_: Request, context: { params: Promise<{ caseId: string }> }) {
  return markPaymentNotReceived(context);
}

async function markPaymentNotReceived(context: { params: Promise<{ caseId: string }> }) {
  const { caseId } = await context.params;
  const existing = await prisma.case.findUnique({ where: { id: caseId } });
  if (!existing) {
    return NextResponse.json({ error: "Prípad neexistuje." }, { status: 404 });
  }

  if (!existing.status.startsWith("CLOSED_")) {
    await prisma.case.update({
      where: { id: caseId },
      data: {
        status: "OVERDUE",
        events: {
          create: [
            {
              actorType: "USER",
              type: CASE_EVENT_TYPES.paymentNotReceivedConfirmed,
              note: "Customer confirmed from the payment-check email that payment was not received."
            },
            {
              actorType: "WORKFLOW",
              type: CASE_EVENT_TYPES.workflowWaiting,
              note: "Case is overdue. Next collection steps can start."
            }
          ]
        }
      }
    });
  }

  return htmlResponse("Platba neprišla", "Prípad bol označený ako po splatnosti. FAKTURIO môže pokračovať ďalšími krokmi.");
}

function htmlResponse(title: string, message: string) {
  return new Response(
    `<!doctype html><html lang="sk"><head><meta charset="utf-8"><title>${title}</title><style>body{font-family:Arial,sans-serif;margin:48px;color:#1d1d1b}a{color:#1d1d1b}</style></head><body><h1>${title}</h1><p>${message}</p><p><a href="/">Späť do FAKTURIO</a></p></body></html>`,
    { headers: { "Content-Type": "text/html; charset=utf-8" } }
  );
}
