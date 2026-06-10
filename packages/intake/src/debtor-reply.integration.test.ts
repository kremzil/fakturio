import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@fakturio/db";
import { MockAiProvider } from "@fakturio/ai";
import {
  CASE_EVENT_TYPES,
  createCaseReplyAddress,
  requireInboundReplyTokenSecret
} from "@fakturio/shared";
import type { InboundEmail } from "@fakturio/email";
import { DebtorReplyService } from "./debtor-reply";

const RUN_ID = `it-reply-${Date.now()}-${Math.floor(Math.random() * 1e5)}`;
const organizationId = `${RUN_ID}-org`;
const debtorId = `${RUN_ID}-debtor`;
const caseId = `${RUN_ID}-case`;

beforeAll(async () => {
  await prisma.organization.create({
    data: { id: organizationId, name: "Reply Org", slug: organizationId }
  });
  await prisma.debtor.create({
    data: {
      id: debtorId,
      organizationId,
      name: "Debtor s.r.o.",
      email: "debtor@example.com"
    }
  });
  await prisma.case.create({
    data: {
      id: caseId,
      organizationId,
      debtorId,
      status: "OVERDUE",
      invoiceNumber: "INV-REPLY-1",
      amountTotal: 100,
      currency: "EUR",
      dueDate: new Date("2026-06-01T00:00:00.000Z")
    }
  });
});

afterAll(async () => {
  await prisma.organization.deleteMany({ where: { id: organizationId } });
  await prisma.$disconnect();
});

describe("inbound debtor replies", () => {
  it("correlates a signed reply address, classifies once and never closes the case", async () => {
    const replyAddress = createCaseReplyAddress(
      { caseId, domain: "reply.example.com" },
      requireInboundReplyTokenSecret()
    );
    const email = inboundEmail({
      providerId: `${RUN_ID}-message-1`,
      to: [replyAddress],
      textBody: "Faktúra bola uhradená."
    });
    const service = new DebtorReplyService(new MockAiProvider());

    const first = await service.process(email);
    const second = await service.process(email);

    expect(first).toMatchObject({
      caseId,
      organizationId,
      duplicate: false,
      classification: { intent: "PAID" }
    });
    expect(second).toMatchObject({
      caseId,
      duplicate: true,
      classification: { intent: "PAID" }
    });

    const collectionCase = await prisma.case.findUniqueOrThrow({
      where: { id: caseId }
    });
    expect(collectionCase.status).toBe("OVERDUE");

    expect(
      await prisma.communication.count({
        where: {
          caseId,
          direction: "INBOUND",
          providerId: email.providerId
        }
      })
    ).toBe(1);
    expect(
      await prisma.caseEvent.count({
        where: { caseId, type: CASE_EVENT_TYPES.debtorReplyClassified }
      })
    ).toBe(1);
  });

  it("correlates standard email thread headers to an outbound communication", async () => {
    const outboundMessageId = `${RUN_ID}-outbound@example.com`;
    await prisma.communication.create({
      data: {
        caseId,
        direction: "OUTBOUND",
        channel: "EMAIL",
        status: "SENT",
        provider: "ses",
        providerId: outboundMessageId,
        messageId: outboundMessageId,
        sentAt: new Date()
      }
    });
    const email = inboundEmail({
      providerId: `${RUN_ID}-message-2`,
      to: ["collections@example.com"],
      inReplyTo: `<${outboundMessageId}>`,
      references: [`<${outboundMessageId}>`],
      textBody: "Zaplatíme budúci týždeň."
    });

    const result = await new DebtorReplyService(new MockAiProvider()).process(email);

    expect(result).toMatchObject({
      caseId,
      classification: { intent: "PROMISED_TO_PAY" }
    });
  });

  it("allows only one concurrent AI classification for the same provider message", async () => {
    const replyAddress = createCaseReplyAddress(
      { caseId, domain: "reply.example.com" },
      requireInboundReplyTokenSecret()
    );
    const email = inboundEmail({
      providerId: `${RUN_ID}-message-3`,
      to: [replyAddress],
      textBody: "Faktúra bola uhradená."
    });
    let classifications = 0;
    class SlowMockAiProvider extends MockAiProvider {
      override async classifyDebtorReply(input: Parameters<MockAiProvider["classifyDebtorReply"]>[0]) {
        classifications += 1;
        await new Promise((resolve) => setTimeout(resolve, 75));
        return super.classifyDebtorReply(input);
      }
    }
    const service = new DebtorReplyService(new SlowMockAiProvider());
    const beforeEvents = await prisma.caseEvent.count({
      where: { caseId, type: CASE_EVENT_TYPES.debtorReplyClassified }
    });

    const results = await Promise.all([
      service.process(email),
      service.process(email)
    ]);

    expect(classifications).toBe(1);
    expect(results.some((result) => result?.classificationPending)).toBe(true);
    expect(
      await prisma.caseEvent.count({
        where: { caseId, type: CASE_EVENT_TYPES.debtorReplyClassified }
      })
    ).toBe(beforeEvents + 1);
  });
});

function inboundEmail(
  overrides: Partial<InboundEmail>
): InboundEmail {
  return {
    provider: "fixture",
    providerId: `${RUN_ID}-message`,
    messageId: null,
    inReplyTo: null,
    references: [],
    from: "debtor@example.com",
    to: [],
    cc: [],
    subject: "Re: Invoice",
    textBody: null,
    htmlBody: null,
    attachments: [],
    raw: {},
    ...overrides
  };
}
