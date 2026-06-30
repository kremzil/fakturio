import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@fakturio/db";
import { CASE_EVENT_TYPES } from "@fakturio/shared";
import { activities } from "./activities";

const RUN_ID = `clar-${Date.now().toString(36)}`;
const organizationId = `${RUN_ID}-org`;
const debtorId = `${RUN_ID}-debtor`;
const caseId = `${RUN_ID}-case`;
const communicationId = `${RUN_ID}-communication`;
const originalEmailDriver = process.env.EMAIL_DRIVER;
const originalInboundReplyTokenSecret = process.env.INBOUND_REPLY_TOKEN_SECRET;
const originalInboundReplyDomain = process.env.INBOUND_REPLY_DOMAIN;

beforeAll(async () => {
  process.env.EMAIL_DRIVER = "fixture";
  process.env.INBOUND_REPLY_TOKEN_SECRET =
    "test-inbound-reply-secret-with-32-characters";
  process.env.INBOUND_REPLY_DOMAIN = "fakturio.test";
  await prisma.organization.create({
    data: {
      id: organizationId,
      name: "Clarification Org",
      slug: organizationId
    }
  });
  await prisma.debtor.create({
    data: {
      id: debtorId,
      organizationId,
      name: "Clarification Debtor",
      email: "clarification-debtor@example.com"
    }
  });
  await prisma.case.create({
    data: {
      id: caseId,
      organizationId,
      debtorId,
      status: "EMAIL_REMINDER_1_SENT",
      invoiceNumber: "INV-CLARIFY-1",
      amountTotal: 100,
      currency: "EUR"
    }
  });
  await prisma.communication.create({
    data: {
      id: communicationId,
      caseId,
      direction: "INBOUND",
      channel: "EMAIL",
      status: "RECEIVED",
      fromAddress: "clarification-debtor@example.com",
      textBody: "Neviem, ozvem sa.",
      receivedAt: new Date(),
      rawPayload: {
        autoSubmitted: null,
        precedence: null
      },
      aiClassification: {
        intent: "IGNORE_OR_OTHER",
        promisedPaymentDate: null,
        installmentRequested: false,
        explicitInstallmentAcceptance: false,
        mentionedPaymentAmount: null,
        summary: "Unclear debtor reply.",
        confidence: 0.5,
        warnings: []
      }
    }
  });
});

afterAll(async () => {
  if (originalEmailDriver === undefined) {
    delete process.env.EMAIL_DRIVER;
  } else {
    process.env.EMAIL_DRIVER = originalEmailDriver;
  }
  if (originalInboundReplyTokenSecret === undefined) {
    delete process.env.INBOUND_REPLY_TOKEN_SECRET;
  } else {
    process.env.INBOUND_REPLY_TOKEN_SECRET = originalInboundReplyTokenSecret;
  }
  if (originalInboundReplyDomain === undefined) {
    delete process.env.INBOUND_REPLY_DOMAIN;
  } else {
    process.env.INBOUND_REPLY_DOMAIN = originalInboundReplyDomain;
  }
  await prisma.organization.deleteMany({ where: { id: { startsWith: RUN_ID } } });
  await prisma.user.deleteMany({
    where: { email: { in: ["customer-notice@example.com"] } }
  });
  await prisma.$disconnect();
});

describe("debtor clarification retry", () => {
  it("keeps the first clarification decision idempotent on activity retry", async () => {
    const input = { caseId, organizationId, communicationId };

    const first = await activities.processDebtorReply(input);
    const retry = await activities.processDebtorReply(input);

    expect(first.kind).toBe("CLARIFICATION_REQUESTED");
    expect(retry.kind).toBe("CLARIFICATION_REQUESTED");
    const collectionCase = await prisma.case.findUniqueOrThrow({
      where: { id: caseId }
    });
    expect(collectionCase.clarificationCount).toBe(1);
    expect(collectionCase.automationPausedAt).toBeNull();
    expect(
      await prisma.communication.count({
        where: {
          caseId,
          idempotencyKey: `debtor-response:clarification:${communicationId}`
        }
      })
    ).toBe(1);
    expect(
      await prisma.caseEvent.count({
        where: {
          caseId,
          type: CASE_EVENT_TYPES.debtorReplyActioned,
          payload: {
            path: ["communicationId"],
            equals: communicationId
          }
        }
      })
    ).toBe(1);
  });

  it("sends customer manual-review notices with a case-specific reply address", async () => {
    const noticeOrgId = `${RUN_ID}-notice-org`;
    const noticeUserId = `${RUN_ID}-notice-user`;
    const noticeDebtorId = `${RUN_ID}-notice-debtor`;
    const noticeCaseId = `${RUN_ID}-notice-case`;
    const noticeCommunicationId = `${RUN_ID}-notice-communication`;

    await prisma.organization.create({
      data: {
        id: noticeOrgId,
        name: "Notice Org",
        slug: noticeOrgId,
        memberships: {
          create: {
            user: {
              create: {
                id: noticeUserId,
                email: "customer-notice@example.com"
              }
            }
          }
        }
      }
    });
    await prisma.debtor.create({
      data: {
        id: noticeDebtorId,
        organizationId: noticeOrgId,
        name: "Notice Debtor",
        email: "notice-debtor@example.com"
      }
    });
    await prisma.case.create({
      data: {
        id: noticeCaseId,
        organizationId: noticeOrgId,
        debtorId: noticeDebtorId,
        confirmedByUserId: noticeUserId,
        status: "EMAIL_REMINDER_1_SENT",
        invoiceNumber: "INV-NOTICE-1",
        amountTotal: 100,
        currency: "EUR"
      }
    });
    await prisma.communication.create({
      data: {
        id: noticeCommunicationId,
        caseId: noticeCaseId,
        direction: "INBOUND",
        channel: "EMAIL",
        status: "RECEIVED",
        fromAddress: "notice-debtor@example.com",
        textBody: "Prosím splátky po 25 EUR.",
        receivedAt: new Date(),
        rawPayload: {
          autoSubmitted: null,
          precedence: null
        },
        aiClassification: {
          intent: "INSTALLMENT_REQUEST",
          promisedPaymentDate: null,
          installmentRequested: true,
          explicitInstallmentAcceptance: false,
          mentionedPaymentAmount: 25,
          summary: "Debtor requests installment payments of 25 EUR.",
          confidence: 0.98,
          warnings: []
        }
      }
    });

    const result = await activities.processDebtorReply({
      caseId: noticeCaseId,
      organizationId: noticeOrgId,
      communicationId: noticeCommunicationId
    });

    expect(result.kind).toBe("PAUSED");
    const notice = await prisma.communication.findUniqueOrThrow({
      where: {
        idempotencyKey: `amount-mismatch-customer:${noticeCommunicationId}`
      }
    });
    expect(notice.toAddress).toBe("customer-notice@example.com");
    expect(notice.rawPayload).toMatchObject({
      kind: "customer-notice",
      replyTo: expect.stringMatching(
        new RegExp(`^clarify\\+${noticeCaseId}\\.[a-f0-9]+@fakturio\\.test$`)
      )
    });
  });
});
