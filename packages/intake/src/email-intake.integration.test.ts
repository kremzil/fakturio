import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { prisma } from "@fakturio/db";
import { MockAiProvider } from "@fakturio/ai";
import {
  createCaseClarificationAddress,
  requireInboundReplyTokenSecret,
  type AiProvider
} from "@fakturio/shared";
import type { EmailProvider, InboundEmail, SendEmailInput } from "@fakturio/email";
import type { StorageProvider } from "@fakturio/storage";
import { CustomerEmailAssistantService } from "./customer-email-assistant";
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
      autoSubmitted: null,
      precedence: null,
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

  it("asks the customer for missing invoice fields and applies their reply", async () => {
    const sent: SendEmailInput[] = [];
    const emailProvider: EmailProvider = {
      async sendEmail(input) {
        sent.push(input);
        return {
          provider: "fixture",
          providerId: `${RUN_ID}-clarification-outbound@example.com`
        };
      },
      async parseInbound() {
        throw new Error("not used");
      }
    };
    const service = new InvoiceIntakeService({
      ai: missingInvoiceAi(),
      storage,
      email: emailProvider
    });
    const email: InboundEmail = {
      provider: "ses",
      providerId: `${RUN_ID}-missing-fields-message`,
      messageId: `${RUN_ID}-missing-fields-message@example.com`,
      inReplyTo: null,
      references: [],
      autoSubmitted: null,
      precedence: null,
      from: "client@example.com",
      to: ["abc-sro@fakturio.test"],
      cc: [],
      subject: "Invoice",
      textBody: "Invoice attached.",
      htmlBody: null,
      attachments: [
        {
          fileName: "needs-clarification.pdf",
          mimeType: "application/pdf",
          bytes: Uint8Array.from([5, 6, 7, 8])
        }
      ],
      raw: {}
    };

    const result = await service.createFromEmail({ organizationId, email });
    const caseId = result.cases[0]?.caseId as string;

    expect(result.cases[0]?.status).toBe("MANUAL_REVIEW_REQUIRED");
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      to: ["client@example.com"],
      replyTo: [expect.stringMatching(/^clarify\+/)]
    });
    expect(sent[0]?.textBody).toContain("Číslo faktúry");

    const clarification = await new CustomerEmailAssistantService({
      ai: missingInvoiceAi(),
      email: emailProvider
    }).process({
      provider: "ses",
      providerId: `${RUN_ID}-clarification-reply`,
      messageId: `${RUN_ID}-clarification-reply@example.com`,
      inReplyTo: null,
      references: [],
      autoSubmitted: null,
      precedence: null,
      from: "client@example.com",
      to: sent[0]?.replyTo ?? [],
      cc: [],
      subject: "Re: clarification",
      textBody: [
        "čislo faktury: 032026.",
        "Dátum splatnosti: 2026-07-15",
        "Suma: 480,00",
        "Odberateľ: Dlžník s.r.o.",
        "",
        "DIČ a variabilny symbol netreba.",
        "Pre istotu, pošlite do mailu na kontrolu, či je všetko spravne",
        "",
        "po 29. 6. 2026 o 13:41 <collection@fakturio.shark.sk> napísal(a):",
        "> Číslo faktúry: FV-2026-001",
        "> Dátum splatnosti: 2026-07-15",
        "> Suma: 480,00",
        "> Odberateľ: Názov dlžníka s.r.o.",
        "> IBAN: SK...",
        "> Variabilný symbol: ..."
      ].join("\n"),
      htmlBody: null,
      attachments: [],
      raw: {}
    });

    expect(clarification).toMatchObject({
      caseId,
      status: "PARSED",
      duplicate: false,
      stillMissing: [],
      intent: "PROVIDE_INVOICE_FIELDS",
      replySent: true
    });
    expect(clarification?.appliedFields).toEqual(
      expect.arrayContaining(["invoiceNumber"])
    );

    const updated = await prisma.case.findUniqueOrThrow({
      where: { id: caseId },
      include: { debtor: true }
    });
    expect(updated.status).toBe("PARSED");
    expect(updated.invoiceNumber).toBe("032026");
    expect(Number(updated.amountTotal)).toBe(480);
    expect(updated.debtor?.name).toBe("Dlžník s.r.o.");
    expect(sent).toHaveLength(2);
    expect(sent[1]?.subject).toContain("stav");
    expect(sent[1]?.replyTo).toEqual([expect.stringMatching(/^clarify\+/)]);
    expect(sent[1]?.textBody).toContain("/confirm-link?token=");
    expect(sent[1]?.textBody).toContain("/?case=");
  });

  it("records customer action requests without mutating case status", async () => {
    const sent: SendEmailInput[] = [];
    const emailProvider: EmailProvider = {
      async sendEmail(input) {
        sent.push(input);
        return {
          provider: "fixture",
          providerId: `${RUN_ID}-blocked-action-outbound@example.com`
        };
      },
      async parseInbound() {
        throw new Error("not used");
      }
    };
    const collectionCase = await prisma.case.create({
      data: {
        organizationId,
        sourceType: "EMAIL",
        status: "WAITING_FOR_DUE_DATE",
        invoiceNumber: "FV-ACTION-1",
        dueDate: new Date("2026-07-10T00:00:00.000Z"),
        amountTotal: 100,
        currency: "EUR",
        confirmedAt: new Date()
      }
    });

    const result = await new CustomerEmailAssistantService({
      ai: actionRequestAi(),
      email: emailProvider
    }).process({
      provider: "ses",
      providerId: `${RUN_ID}-blocked-action`,
      messageId: `${RUN_ID}-blocked-action@example.com`,
      inReplyTo: null,
      references: [],
      autoSubmitted: null,
      precedence: null,
      from: "client@example.com",
      to: [signedClarifyAddressForTest(collectionCase.id)],
      cc: [],
      subject: "Re: mark paid",
      textBody: "Prosím označte faktúru ako uhradenú.",
      htmlBody: null,
      attachments: [],
      raw: {}
    });

    expect(result).toMatchObject({
      caseId: collectionCase.id,
      intent: "REQUEST_MARK_PAID",
      appliedFields: [],
      replySent: true
    });
    const unchanged = await prisma.case.findUniqueOrThrow({
      where: { id: collectionCase.id }
    });
    expect(unchanged.status).toBe("WAITING_FOR_DUE_DATE");
    expect(sent[0]?.textBody).toContain("automaticky nevykonáme");
  });
});

function missingInvoiceAi(): AiProvider {
  return {
    async extractInvoice() {
      return {
        invoiceNumber: null,
        issueDate: null,
        dueDate: null,
        amountTotal: null,
        currency: null,
        supplier: {
          name: "ABC s.r.o.",
          email: "client@example.com",
          ico: null,
          dic: null,
          icDph: null,
          address: null
        },
        debtor: {
          name: null,
          email: null,
          ico: null,
          dic: null,
          icDph: null,
          address: null
        },
        payment: {
          iban: null,
          variableSymbol: null,
          constantSymbol: null,
          specificSymbol: null
        },
        subjectNote: null,
        confidence: 0.4,
        manualReviewRequired: true,
        warnings: ["Niektoré údaje nie sú čitateľné."],
        rawResult: { test: true }
      };
    },
    async classifyDebtorReply() {
      throw new Error("not used");
    },
    async classifyCustomerMessage() {
      return {
        intent: "PROVIDE_INVOICE_FIELDS",
        confidence: 0.94,
        summary: "Customer provided the invoice number and asked to send details by email for checking.",
        extractedInvoiceFields: {
          invoiceNumber: null,
          dueDate: null,
          amountTotal: null,
          currency: null,
          debtorName: null,
          debtorEmail: null,
          supplierName: null,
          iban: null,
          variableSymbol: null
        },
        debtorContactPatch: {
          email: null,
          name: null
        },
        caseReference: {
          caseId: null,
          invoiceNumber: null,
          debtorName: null
        },
        customerNote: null,
        requestedAction: "send details by email for review",
        needsHumanReview: true,
        replyDraft: null
      };
    },
    async generateDebtorEmail() {
      throw new Error("not used");
    },
    async summarizeCase() {
      throw new Error("not used");
    }
  };
}

function actionRequestAi(): AiProvider {
  return {
    async extractInvoice() {
      throw new Error("not used");
    },
    async classifyDebtorReply() {
      throw new Error("not used");
    },
    async classifyCustomerMessage() {
      return {
        intent: "REQUEST_MARK_PAID",
        confidence: 0.96,
        summary: "Customer asked to mark the invoice as paid.",
        extractedInvoiceFields: {
          invoiceNumber: null,
          dueDate: null,
          amountTotal: null,
          currency: null,
          debtorName: null,
          debtorEmail: null,
          supplierName: null,
          iban: null,
          variableSymbol: null
        },
        debtorContactPatch: {
          email: null,
          name: null
        },
        caseReference: {
          caseId: null,
          invoiceNumber: null,
          debtorName: null
        },
        customerNote: "Customer asked to mark paid.",
        requestedAction: "MARK_PAID",
        needsHumanReview: false,
        replyDraft: null
      };
    },
    async generateDebtorEmail() {
      throw new Error("not used");
    },
    async summarizeCase() {
      throw new Error("not used");
    }
  };
}

function signedClarifyAddressForTest(caseId: string): string {
  return createCaseClarificationAddress(
    { caseId, domain: "fakturio.test" },
    requireInboundReplyTokenSecret()
  );
}
