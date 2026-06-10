import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { prisma } from "@fakturio/db";
import { MockAiProvider } from "@fakturio/ai";
import type { InboundEmail } from "@fakturio/email";
import type { StorageProvider } from "@fakturio/storage";
import { InvoiceIntakeService } from "./service";

const RUN_ID = `it-email-${Date.now()}-${Math.floor(Math.random() * 1e5)}`;
const organizationId = `${RUN_ID}-org`;

const putObject = vi.fn(async (input: Parameters<StorageProvider["putObject"]>[0]) => ({
  bucket: "test-bucket",
  key: `${RUN_ID}/${input.caseId}/${input.fileName}`,
  sizeBytes: input.body.byteLength,
  contentType: input.contentType
}));

const storage: StorageProvider = {
  putObject,
  async getSignedUrl() {
    return "http://example.test/file";
  },
  async deleteObject() {}
};

beforeAll(async () => {
  await prisma.organization.create({
    data: { id: organizationId, name: "Email Intake Org", slug: organizationId }
  });
});

afterAll(async () => {
  await prisma.organization.deleteMany({ where: { id: organizationId } });
  await prisma.$disconnect();
});

describe("email invoice intake idempotency", () => {
  it("returns the existing case when an email attachment is delivered again", async () => {
    const email: InboundEmail = {
      provider: "ses",
      providerId: `${RUN_ID}-message`,
      messageId: `${RUN_ID}-message@example.com`,
      inReplyTo: null,
      references: [],
      from: "supplier@example.com",
      to: ["invoices@example.com"],
      cc: [],
      subject: "Invoice",
      textBody: "Invoice attached.",
      htmlBody: null,
      attachments: [
        {
          fileName: "invoice.pdf",
          mimeType: "application/pdf",
          bytes: Uint8Array.from([1, 2, 3, 4])
        }
      ],
      raw: {}
    };
    const service = new InvoiceIntakeService({
      ai: new MockAiProvider(),
      storage
    });

    const first = await service.createFromEmail({ organizationId, email });
    const second = await service.createFromEmail({ organizationId, email });

    expect(second.cases[0]?.caseId).toBe(first.cases[0]?.caseId);
    expect(putObject).toHaveBeenCalledTimes(1);
    expect(
      await prisma.case.count({
        where: { organizationId, sourceType: "EMAIL" }
      })
    ).toBe(1);
    expect(
      await prisma.communication.count({
        where: { caseId: first.cases[0]?.caseId, direction: "INBOUND" }
      })
    ).toBe(1);
  });
});
