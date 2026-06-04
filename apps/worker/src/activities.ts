import {
  CASE_EVENT_TYPES,
  createPaymentCheckToken,
  PAYMENT_CHECK_TOKEN_DEFAULT_TTL_MS,
  requirePaymentCheckTokenSecret
} from "@fakturio/shared";
import { prisma } from "@fakturio/db";
import { Prisma } from "@prisma/client";
import { createEmailProvider } from "@fakturio/email";
import {
  PAYMENT_CHECK_SEND_LEASE_MS,
  type CaseSnapshot,
  type CaseWorkflowActivities
} from "@fakturio/workflows";
import { randomUUID } from "node:crypto";

export const activities: CaseWorkflowActivities = {
  async loadCaseSnapshot(input): Promise<CaseSnapshot> {
    const collectionCase = await prisma.case.findUniqueOrThrow({
      where: { id: input.caseId },
      include: { debtor: true }
    });

    assertCaseOrganization(collectionCase.id, collectionCase.organizationId, input.organizationId);

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
    await assertCaseInOrganization(input.caseId, input.organizationId);
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
    await assertCaseInOrganization(input.caseId, input.organizationId);
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
    assertCaseOrganization(collectionCase.id, collectionCase.organizationId, input.organizationId);
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

    const secret = requirePaymentCheckTokenSecret();
    const expiresAt = Date.now() + paymentCheckTokenTtlMs();
    const paidToken = createPaymentCheckToken(
      { caseId: collectionCase.id, organizationId: collectionCase.organizationId, action: "PAID", expiresAt },
      secret
    );
    const notPaidToken = createPaymentCheckToken(
      { caseId: collectionCase.id, organizationId: collectionCase.organizationId, action: "NOT_PAID", expiresAt },
      secret
    );
    const paidUrl = `${publicUrl}/api/cases/${collectionCase.id}/payment-check/paid?token=${paidToken}`;
    const notPaidUrl = `${publicUrl}/api/cases/${collectionCase.id}/payment-check/not-paid?token=${notPaidToken}`;
    const subject = `FAKTURIO: prišla úhrada faktúry ${invoiceNumber}?`;
    const textBody = [
      `Dobrý deň,`,
      ``,
      `faktúra ${invoiceNumber} pre ${debtor} mala splatnosť ${dueDate}.`,
      `Suma: ${amount}.`,
      ``,
      `Potvrďte, prosím, či platba prišla:`,
      `Platba prišla: ${paidUrl}`,
      `Platba neprišla: ${notPaidUrl}`
    ].join("\n");
    const htmlBody = `
      <p>Dobrý deň,</p>
      <p>faktúra <strong>${escapeHtml(invoiceNumber)}</strong> pre <strong>${escapeHtml(debtor)}</strong> mala splatnosť ${escapeHtml(dueDate)}.</p>
      <p>Suma: <strong>${escapeHtml(amount)}</strong></p>
      <p>
        <a href="${escapeHtml(paidUrl)}" style="display:inline-block;padding:10px 14px;background:#1d1d1b;color:#fff;text-decoration:none;border-radius:6px">Platba prišla</a>
        <a href="${escapeHtml(notPaidUrl)}" style="display:inline-block;padding:10px 14px;margin-left:8px;border:1px solid #1d1d1b;color:#1d1d1b;text-decoration:none;border-radius:6px">Platba neprišla</a>
      </p>
    `;
    const fromAddress = process.env.SES_FROM_EMAIL || "system@example.com";

    // Outbox claim with a retry-aware lease. Temporal retries this activity up to 5 times, so
    // the Communication row (uniquely keyed by caseId + payment-check + dueDate) is the durable
    // record of whether this email has actually been delivered:
    //  - A row already in status SENT means a previous attempt confirmed delivery, so we stop.
    //    This is true idempotency: an email that already went out is never resent.
    //  - A DRAFT/FAILED row can be reclaimed only when it has no active send lease. This makes
    //    concurrent activity executions race through one conditional update, so only the winner
    //    calls the provider.
    //  - A crash between sending and the confirming write can still yield one duplicate after
    //    the lease expires. That is the unavoidable provider-boundary tradeoff without provider
    //    idempotency support; it is preferable to permanently losing the email and audit trail.
    const idempotencyKey = `payment-check:${collectionCase.id}:${dueDate}`;

    const draftData = {
      caseId: collectionCase.id,
      direction: "OUTBOUND" as const,
      channel: "EMAIL" as const,
      status: "DRAFT" as const,
      idempotencyKey,
      fromAddress,
      toAddress: recipient,
      subject,
      textBody,
      htmlBody
    };

    const lease = await acquireCommunicationSendLease(idempotencyKey, draftData);
    if (!lease) {
      return;
    }

    let email: Awaited<ReturnType<ReturnType<typeof createEmailProvider>["sendEmail"]>>;
    try {
      email = await createEmailProvider().sendEmail({
        from: fromAddress,
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
    } catch (error) {
      // Record the failed attempt and rethrow so Temporal retries. The next attempt sees a
      // DRAFT/FAILED row and resends, instead of reporting a delivery that never happened.
      await prisma.communication
        .updateMany({
          where: { id: lease.communicationId, sendLeaseId: lease.leaseId },
          data: { status: "FAILED", sendLeaseId: null, sendLeaseUntil: null }
        })
        .catch(() => undefined);
      throw error;
    }

    // Confirm delivery atomically: marking the row SENT and writing the audit event share one
    // transaction. The lease predicate prevents an expired attempt from confirming over a newer
    // sender. If this write fails the row stays leased until expiry, then a retry can resend.
    await prisma.$transaction(async (tx) => {
      const confirmed = await tx.communication.updateMany({
        where: {
          id: lease.communicationId,
          sendLeaseId: lease.leaseId,
          status: { in: ["DRAFT", "FAILED"] }
        },
        data: {
          status: "SENT",
          provider: email.provider,
          providerId: email.providerId,
          sentAt: new Date(),
          sendLeaseId: null,
          sendLeaseUntil: null
        }
      });

      if (confirmed.count !== 1) {
        throw new Error(`Payment-check send lease for communication ${lease.communicationId} was lost before confirmation.`);
      }

      await tx.caseEvent.create({
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
    });
  },

  async markCaseOverdue(input) {
    const changed = await prisma.case.updateMany({
      where: { id: input.caseId, organizationId: input.organizationId },
      data: { status: "OVERDUE" }
    });

    if (changed.count === 0) {
      throw new Error(
        `Case ${input.caseId} was not found in organization ${input.organizationId}; refusing to mark overdue.`
      );
    }
  }
};

async function getCustomerCheckRecipient(organizationId: string, confirmedByUserId: string | null): Promise<string | null> {
  if (confirmedByUserId) {
    // Only email the confirming user if they are STILL a member of the organization. A user
    // removed from the org must not keep receiving invoice data and signed action links.
    const membership = await prisma.membership.findFirst({
      where: { organizationId, userId: confirmedByUserId },
      include: { user: true }
    });
    if (membership?.user.email) {
      return membership.user.email;
    }
  }

  const membership = await prisma.membership.findFirst({
    where: { organizationId },
    include: { user: true },
    orderBy: { createdAt: "asc" }
  });

  return membership?.user.email ?? null;
}

function isUniqueConstraintViolation(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002";
}

type PaymentCheckDraftData = {
  caseId: string;
  direction: "OUTBOUND";
  channel: "EMAIL";
  status: "DRAFT";
  idempotencyKey: string;
  fromAddress: string;
  toAddress: string;
  subject: string;
  textBody: string;
  htmlBody: string;
};

type CommunicationSendLease = {
  communicationId: string;
  leaseId: string;
};

async function acquireCommunicationSendLease(
  idempotencyKey: string,
  draftData: PaymentCheckDraftData
): Promise<CommunicationSendLease | null> {
  const leaseId = randomUUID();
  const now = new Date();
  const sendLeaseUntil = new Date(now.getTime() + PAYMENT_CHECK_SEND_LEASE_MS);

  const existing = await prisma.communication.findUnique({
    where: { idempotencyKey },
    select: { id: true, status: true }
  });

  if (!existing) {
    try {
      const created = await prisma.communication.create({
        data: { ...draftData, sendLeaseId: leaseId, sendLeaseUntil },
        select: { id: true }
      });
      return { communicationId: created.id, leaseId };
    } catch (error) {
      if (!isUniqueConstraintViolation(error)) {
        throw error;
      }
    }
  } else if (existing.status === "SENT") {
    return null;
  }

  const claimed = await prisma.communication.updateManyAndReturn({
    where: {
      idempotencyKey,
      status: { in: ["DRAFT", "FAILED"] },
      OR: [{ sendLeaseUntil: null }, { sendLeaseUntil: { lt: now } }]
    },
    data: {
      ...draftData,
      status: "DRAFT",
      sendLeaseId: leaseId,
      sendLeaseUntil,
      provider: null,
      providerId: null,
      sentAt: null
    },
    select: { id: true }
  });

  if (claimed.length !== 1) {
    const current = await prisma.communication.findUnique({
      where: { idempotencyKey },
      select: { id: true, status: true }
    });
    if (current?.status === "SENT") {
      return null;
    }
    throw new Error(`Payment-check communication ${idempotencyKey} already has an active send lease.`);
  }

  return { communicationId: claimed[0].id, leaseId };
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function assertCaseOrganization(caseId: string, actualOrganizationId: string, expectedOrganizationId: string): void {
  if (actualOrganizationId !== expectedOrganizationId) {
    throw new Error(
      `Case ${caseId} belongs to organization ${actualOrganizationId} but workflow expected ${expectedOrganizationId}.`
    );
  }
}

async function assertCaseInOrganization(caseId: string, expectedOrganizationId: string): Promise<void> {
  const found = await prisma.case.findUnique({
    where: { id: caseId },
    select: { organizationId: true }
  });

  if (!found) {
    throw new Error(`Case ${caseId} not found.`);
  }

  assertCaseOrganization(caseId, found.organizationId, expectedOrganizationId);
}

function paymentCheckTokenTtlMs(): number {
  const days = Number(process.env.PAYMENT_CHECK_TOKEN_TTL_DAYS);
  if (Number.isFinite(days) && days > 0) {
    return days * 24 * 60 * 60 * 1000;
  }
  return PAYMENT_CHECK_TOKEN_DEFAULT_TTL_MS;
}
