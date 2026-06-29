import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@fakturio/db";
import {
  CASE_EVENT_TYPES,
  createCaseReplyAddress,
  requireInboundReplyTokenSecret,
  WORKFLOW_COMMAND_TYPES
} from "@fakturio/shared";
import type { InboundEmail } from "@fakturio/email";
import type { StorageProvider } from "@fakturio/storage";
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
      status: "EMAIL_REMINDER_1_SENT",
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

describe("inbound debtor reply intake", () => {
  it("stores once and enqueues classification for Temporal", async () => {
    const replyAddress = createCaseReplyAddress(
      { caseId, domain: "reply.example.com" },
      requireInboundReplyTokenSecret()
    );
    const email = inboundEmail({
      providerId: `${RUN_ID}-message-1`,
      to: [replyAddress],
      textBody: "Faktúra bola uhradená."
    });
    const service = new DebtorReplyService();

    const first = await service.process(email);
    const second = await service.process(email);

    expect(first).toMatchObject({
      caseId,
      organizationId,
      duplicate: false,
      classification: null,
      classificationPending: true
    });
    expect(second).toMatchObject({
      caseId,
      duplicate: true,
      classificationPending: true
    });
    expect(
      await prisma.communication.count({
        where: { caseId, providerId: email.providerId }
      })
    ).toBe(1);
    expect(
      await prisma.workflowCommand.count({
        where: {
          caseId,
          type: WORKFLOW_COMMAND_TYPES.debtorReplyReceived
        }
      })
    ).toBe(1);
    expect(
      await prisma.caseEvent.count({
        where: { caseId, type: CASE_EVENT_TYPES.emailReceived }
      })
    ).toBe(1);
  });

  it("correlates standard thread headers to an outbound communication", async () => {
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
    const result = await new DebtorReplyService().process(
      inboundEmail({
        providerId: `${RUN_ID}-message-2`,
        to: ["collections@example.com"],
        inReplyTo: `<${outboundMessageId}>`,
        references: [`<${outboundMessageId}>`],
        textBody: "Zaplatíme budúci týždeň."
      })
    );
    expect(result).toMatchObject({ caseId, classificationPending: true });
  });

  it("stores reply attachments once without treating them as payment proof", async () => {
    const storedKeys: string[] = [];
    const storage: StorageProvider = {
      async putObject(input) {
        const key = `test/${input.kind}/${input.fileName}`;
        storedKeys.push(key);
        return {
          bucket: "test-bucket",
          key,
          sizeBytes: input.body.byteLength,
          contentType: input.contentType
        };
      },
      async getObject() {
        throw new Error("not used");
      },
      async getSignedUrl() {
        return "https://example.test/attachment";
      },
      async deleteObject() {}
    };
    const replyAddress = createCaseReplyAddress(
      { caseId, domain: "reply.example.com" },
      requireInboundReplyTokenSecret()
    );
    const email = inboundEmail({
      providerId: `${RUN_ID}-message-with-attachment`,
      to: [replyAddress],
      textBody: "Doklad prikladám.",
      attachments: [
        {
          fileName: "doklad.pdf",
          mimeType: "application/pdf",
          bytes: new Uint8Array([1, 2, 3])
        }
      ]
    });
    const service = new DebtorReplyService(storage);

    const first = await service.process(email);
    const second = await service.process(email);

    expect(first?.classificationPending).toBe(true);
    expect(second?.duplicate).toBe(true);
    expect(storedKeys).toHaveLength(1);
    expect(
      await prisma.communicationAttachment.count({
        where: { communicationId: first?.communicationId }
      })
    ).toBe(1);
  });

  it("does not store unsupported or oversized reply attachments", async () => {
    const storedNames: string[] = [];
    const storage: StorageProvider = {
      async putObject(input) {
        storedNames.push(input.fileName);
        return {
          bucket: "test-bucket",
          key: `test/${input.fileName}`,
          sizeBytes: input.body.byteLength,
          contentType: input.contentType
        };
      },
      async getObject() {
        throw new Error("not used");
      },
      async getSignedUrl() {
        return "https://example.test/attachment";
      },
      async deleteObject() {}
    };
    const replyAddress = createCaseReplyAddress(
      { caseId, domain: "reply.example.com" },
      requireInboundReplyTokenSecret()
    );
    const result = await new DebtorReplyService(storage).process(
      inboundEmail({
        providerId: `${RUN_ID}-message-rejected-attachments`,
        to: [replyAddress],
        attachments: [
          {
            fileName: "payload.exe",
            mimeType: "application/octet-stream",
            bytes: new Uint8Array([1])
          },
          {
            fileName: "oversized.pdf",
            mimeType: "application/pdf",
            bytes: new Uint8Array(10 * 1024 * 1024 + 1)
          }
        ]
      })
    );

    expect(storedNames).toEqual([]);
    const communication = await prisma.communication.findUniqueOrThrow({
      where: { id: result!.communicationId }
    });
    expect(communication.rawPayload).toMatchObject({
      rejectedAttachments: [
        { fileName: "payload.exe", reason: "UNSUPPORTED_TYPE" },
        { fileName: "oversized.pdf", reason: "FILE_TOO_LARGE" }
      ]
    });
  });
});

function inboundEmail(overrides: Partial<InboundEmail>): InboundEmail {
  return {
    provider: "fixture",
    providerId: `${RUN_ID}-message`,
    messageId: null,
    inReplyTo: null,
    references: [],
    autoSubmitted: null,
    precedence: null,
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
