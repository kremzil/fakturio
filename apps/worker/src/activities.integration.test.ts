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

beforeAll(async () => {
  process.env.EMAIL_DRIVER = "fixture";
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
  await prisma.organization.deleteMany({ where: { id: organizationId } });
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
});
