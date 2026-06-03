import { CASE_EVENT_TYPES } from "@fakturio/shared";
import { prisma } from "@fakturio/db";
import { createEmailProvider } from "@fakturio/email";
import type { CaseSnapshot, CaseWorkflowActivities } from "@fakturio/workflows";

export const activities: CaseWorkflowActivities = {
  async loadCaseSnapshot(input): Promise<CaseSnapshot> {
    const collectionCase = await prisma.case.findUniqueOrThrow({
      where: { id: input.caseId },
      include: { debtor: true }
    });

    return {
      id: collectionCase.id,
      status: collectionCase.status,
      dueDate: collectionCase.dueDate?.toISOString().slice(0, 10) ?? null,
      invoiceNumber: collectionCase.invoiceNumber,
      amountTotal: collectionCase.amountTotal ? Number(collectionCase.amountTotal) : null,
      currency: collectionCase.currency,
      debtorName: collectionCase.debtor?.name ?? null,
      debtorEmail: collectionCase.debtor?.email ?? null,
      customerEmail: await getCustomerCheckRecipient(collectionCase.organizationId, collectionCase.confirmedByUserId),
      organizationName: null
    };
  },

  async recordWorkflowEvent(input) {
    await prisma.caseEvent.create({
      data: {
        caseId: input.caseId,
        actorType: "WORKFLOW",
        type: input.type,
        note: input.note
      }
    });
  },

  async sendReminderEmail(input) {
    await prisma.caseEvent.create({
      data: {
        caseId: input.caseId,
        actorType: "WORKFLOW",
        type: CASE_EVENT_TYPES.emailSent,
        note: `Reminder ${input.reminderLevel} scheduled for email provider.`
      }
    });
  },

  async sendPaymentCheckEmail(input) {
    const collectionCase = await prisma.case.findUniqueOrThrow({
      where: { id: input.caseId },
      include: {
        debtor: true,
        organization: true
      }
    });
    const recipient = await getCustomerCheckRecipient(collectionCase.organizationId, collectionCase.confirmedByUserId);

    if (!recipient) {
      await prisma.caseEvent.create({
        data: {
          caseId: input.caseId,
          actorType: "WORKFLOW",
          type: CASE_EVENT_TYPES.paymentCheckSent,
          note: "Payment check email was not sent because no customer recipient email is configured."
        }
      });
      return;
    }

    const publicUrl = process.env.NEXTAUTH_URL || process.env.APP_URL || "http://localhost:3000";
    const invoiceNumber = collectionCase.invoiceNumber ?? collectionCase.id;
    const amount = collectionCase.amountTotal ? `${Number(collectionCase.amountTotal).toFixed(2)} ${collectionCase.currency ?? ""}` : "nezistená suma";
    const debtor = collectionCase.debtor?.name ?? "nezistený odberateľ";
    const dueDate = collectionCase.dueDate?.toISOString().slice(0, 10) ?? "nezistený dátum";
    const paidUrl = `${publicUrl}/api/cases/${collectionCase.id}/payment-check/paid`;
    const notPaidUrl = `${publicUrl}/api/cases/${collectionCase.id}/payment-check/not-paid`;
    const subject = `FAKTURIO: prišla úhrada faktúry ${invoiceNumber}?`;
    const textBody = [
      `Dobrý deň,`,
      ``,
      `faktúra ${invoiceNumber} pre ${debtor} mala splatnosť ${dueDate}.`,
      `Suma: ${amount}.`,
      ``,
      `Potvrďte, prosím, či platba prišla:`,
      `Opлата поступила: ${paidUrl}`,
      `Оплата не поступила: ${notPaidUrl}`
    ].join("\n");
    const htmlBody = `
      <p>Dobrý deň,</p>
      <p>faktúra <strong>${escapeHtml(invoiceNumber)}</strong> pre <strong>${escapeHtml(debtor)}</strong> mala splatnosť ${escapeHtml(dueDate)}.</p>
      <p>Suma: <strong>${escapeHtml(amount)}</strong></p>
      <p>
        <a href="${paidUrl}" style="display:inline-block;padding:10px 14px;background:#1d1d1b;color:#fff;text-decoration:none;border-radius:6px">Оплата поступила</a>
        <a href="${notPaidUrl}" style="display:inline-block;padding:10px 14px;margin-left:8px;border:1px solid #1d1d1b;color:#1d1d1b;text-decoration:none;border-radius:6px">Оплата не поступила</a>
      </p>
    `;
    const email = await createEmailProvider().sendEmail({
      from: process.env.SES_FROM_EMAIL || "system@example.com",
      to: [recipient],
      subject,
      textBody,
      htmlBody,
      metadata: {
        caseId: collectionCase.id,
        organizationId: collectionCase.organizationId,
        kind: "payment-check"
      }
    });

    await prisma.communication.create({
      data: {
        caseId: collectionCase.id,
        direction: "OUTBOUND",
        channel: "EMAIL",
        status: "SENT",
        provider: email.provider,
        providerId: email.providerId,
        fromAddress: process.env.SES_FROM_EMAIL || "system@example.com",
        toAddress: recipient,
        subject,
        textBody,
        htmlBody,
        sentAt: new Date()
      }
    });

    await prisma.caseEvent.create({
      data: {
        caseId: input.caseId,
        actorType: "WORKFLOW",
        type: CASE_EVENT_TYPES.paymentCheckSent,
        note: `Payment check email sent to ${recipient}.`,
        payload: {
          provider: email.provider,
          providerId: email.providerId,
          paidUrl,
          notPaidUrl
        }
      }
    });
  },

  async markCaseOverdue(input) {
    await prisma.case.update({
      where: { id: input.caseId },
      data: { status: "OVERDUE" }
    });
  }
};

async function getCustomerCheckRecipient(organizationId: string, confirmedByUserId: string | null): Promise<string | null> {
  if (confirmedByUserId) {
    const user = await prisma.user.findUnique({ where: { id: confirmedByUserId } });
    if (user?.email) {
      return user.email;
    }
  }

  const membership = await prisma.membership.findFirst({
    where: { organizationId },
    include: { user: true },
    orderBy: { createdAt: "asc" }
  });

  return membership?.user.email ?? null;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
