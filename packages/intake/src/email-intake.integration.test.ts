import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { prisma } from "@fakturio/db";
import { MockAiProvider } from "@fakturio/ai";
import {
  CUSTOMER_COMMUNICATION_KINDS,
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
const storedObjects = new Map<
  string,
  { body: Uint8Array; contentType: string; sizeBytes: number }
>();

const putObject = vi.fn(async (input: Parameters<StorageProvider["putObject"]>[0]) => {
  const key = `${RUN_ID}/${input.caseId}/${input.fileName}`;
  storedObjects.set(`test-bucket/${key}`, {
    body: input.body,
    contentType: input.contentType,
    sizeBytes: input.body.byteLength
  });
  return {
    bucket: "test-bucket",
    key,
    sizeBytes: input.body.byteLength,
    contentType: input.contentType
  };
});

const storage: StorageProvider = {
  putObject,
  async getObject(input) {
    const stored = storedObjects.get(`${input.bucket}/${input.key}`);
    if (!stored) {
      throw new Error(`Missing stored object ${input.bucket}/${input.key}`);
    }
    return stored;
  },
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

  it("includes a start link after missing fields make the case ready", async () => {
    const sent: SendEmailInput[] = [];
    const emailProvider: EmailProvider = {
      async sendEmail(input) {
        sent.push(input);
        return {
          provider: "fixture",
          providerId: `${RUN_ID}-ready-after-fields-outbound@example.com`
        };
      },
      async parseInbound() {
        throw new Error("not used");
      }
    };
    const debtor = await prisma.debtor.create({
      data: {
        organizationId,
        name: "Ready Debtor s.r.o.",
        email: "ready-debtor@example.com"
      }
    });
    const collectionCase = await prisma.case.create({
      data: {
        organizationId,
        sourceType: "EMAIL",
        status: "MANUAL_REVIEW_REQUIRED",
        dueDate: new Date("2026-07-15T00:00:00.000Z"),
        amountTotal: 480,
        currency: "EUR",
        debtorId: debtor.id,
        warnings: ["Invoice number not visible"]
      }
    });
    const classifyCustomerMessage = vi.fn(async () =>
      customerClassification({
        intent: "PROVIDE_INVOICE_FIELDS",
        summary: "Customer provided the invoice number.",
        extractedInvoiceFields: {
          ...emptyFields(),
          invoiceNumber: "FV-READY-1"
        }
      })
    );

    const result = await new CustomerEmailAssistantService({
      ai: customerMessageOnlyAi(classifyCustomerMessage),
      email: emailProvider
    }).process({
      provider: "ses",
      providerId: `${RUN_ID}-ready-after-fields`,
      messageId: `${RUN_ID}-ready-after-fields@example.com`,
      inReplyTo: null,
      references: [],
      autoSubmitted: null,
      precedence: null,
      from: "client@example.com",
      to: [
        createCaseClarificationAddress(
          { caseId: collectionCase.id, domain: "fakturio.test" },
          requireInboundReplyTokenSecret()
        )
      ],
      cc: [],
      subject: "Re: missing invoice number",
      textBody: "Číslo faktúry je FV-READY-1.",
      htmlBody: null,
      attachments: [],
      raw: {}
    });

    expect(result).toMatchObject({
      caseId: collectionCase.id,
      status: "PARSED",
      intent: "PROVIDE_INVOICE_FIELDS",
      stillMissing: []
    });
    expect(sent).toHaveLength(1);
    expect(sent[0]?.textBody).toContain("READY-1");
    expect(sent[0]?.textBody).toContain("/confirm-link?token=");
    expect(sent[0]?.textBody).toContain("/?case=");
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

  it("uses one AI pass for alias case matching and does not include confirm links in status-only replies", async () => {
    const sent: SendEmailInput[] = [];
    const emailProvider: EmailProvider = {
      async sendEmail(input) {
        sent.push(input);
        return {
          provider: "fixture",
          providerId: `${RUN_ID}-alias-status-outbound@example.com`
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
        status: "PARSED",
        invoiceNumber: "FV-ALIAS-STATUS",
        dueDate: new Date("2026-07-10T00:00:00.000Z"),
        amountTotal: 100,
        currency: "EUR",
        debtorSnapshot: { name: "Alias Debtor s.r.o." }
      }
    });
    const classifyCustomerMessage = vi.fn(async () => ({
      intent: "ASK_CASE_STATUS" as const,
      confidence: 0.96,
      summary: "Customer asked for case status.",
      extractedInvoiceFields: emptyFields(),
      debtorContactPatch: { email: null, name: null },
      caseReference: {
        caseId: collectionCase.id,
        invoiceNumber: "FV-ALIAS-STATUS",
        debtorName: null
      },
      customerNote: null,
      requestedAction: null,
      needsHumanReview: false,
      replyDraft: null
    }));

    const result = await new CustomerEmailAssistantService({
      ai: customerMessageOnlyAi(classifyCustomerMessage),
      email: emailProvider
    }).process(
      inboundEmail({
        providerId: `${RUN_ID}-alias-status`,
        subject: "FV-ALIAS-STATUS",
        textBody: "Aký je stav prípadu FV-ALIAS-STATUS?",
        attachments: []
      }),
      {
        organizationId,
        matchedAddress: "abc-sro@fakturio.test"
      }
    );

    expect(result).toMatchObject({
      caseId: collectionCase.id,
      intent: "ASK_CASE_STATUS",
      replySent: true
    });
    expect(classifyCustomerMessage).toHaveBeenCalledTimes(1);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.textBody).not.toContain("/confirm-link?token=");
    expect(sent[0]?.textBody).toContain("/?case=");
  });

  it("starts a reviewed case when the customer explicitly confirms by email", async () => {
    const sent: SendEmailInput[] = [];
    const emailProvider: EmailProvider = {
      async sendEmail(input) {
        sent.push(input);
        return {
          provider: "fixture",
          providerId: `${RUN_ID}-email-confirm-outbound@example.com`
        };
      },
      async parseInbound() {
        throw new Error("not used");
      }
    };
    const debtor = await prisma.debtor.create({
      data: {
        organizationId,
        name: "Email Confirm Debtor s.r.o.",
        email: "email-confirm-debtor@example.com"
      }
    });
    const collectionCase = await prisma.case.create({
      data: {
        organizationId,
        debtorId: debtor.id,
        sourceType: "EMAIL",
        status: "PARSED",
        invoiceNumber: "FV-EMAIL-CONFIRM",
        dueDate: new Date("2026-07-10T00:00:00.000Z"),
        amountTotal: 300,
        currency: "EUR"
      }
    });

    const result = await new CustomerEmailAssistantService({
      ai: customerMessageOnlyAi(async () =>
        customerClassification({
          intent: "REQUEST_CONFIRM_INVOICE",
          summary: "Customer confirmed the invoice and asked to start the case.",
          requestedAction: "spustiť prípad"
        })
      ),
      email: emailProvider
    }).process(
      inboundEmail({
        providerId: `${RUN_ID}-email-confirm`,
        from: "client@example.com",
        to: [signedClarifyAddressForTest(collectionCase.id)],
        subject: "Re: kontrola",
        textBody: "Potvrdzujem, spusti prípad.",
        attachments: []
      })
    );

    expect(result).toMatchObject({
      caseId: collectionCase.id,
      status: "WAITING_FOR_DUE_DATE",
      intent: "REQUEST_CONFIRM_INVOICE",
      replySent: true
    });
    const updated = await prisma.case.findUniqueOrThrow({
      where: { id: collectionCase.id }
    });
    expect(updated.confirmedAt).toBeTruthy();
    expect(updated.status).toBe("WAITING_FOR_DUE_DATE");
    expect(
      await prisma.caseEvent.count({
        where: {
          caseId: collectionCase.id,
          type: "WORKFLOW_WAITING"
        }
      })
    ).toBe(1);
    expect(sent[0]?.textBody).toContain("spustili automatickú kontrolu");
  });

  it("sends a standard installment proposal when the customer authorizes it by email", async () => {
    const sent: SendEmailInput[] = [];
    const emailProvider: EmailProvider = {
      async sendEmail(input) {
        sent.push(input);
        return {
          provider: "fixture",
          providerId: `${RUN_ID}-installment-authorized-${sent.length}@example.com`
        };
      },
      async parseInbound() {
        throw new Error("not used");
      }
    };
    const debtor = await prisma.debtor.create({
      data: {
        organizationId,
        name: "Installment Debtor s.r.o.",
        email: "installment-debtor@example.com"
      }
    });
    const collectionCase = await prisma.case.create({
      data: {
        organizationId,
        debtorId: debtor.id,
        sourceType: "EMAIL",
        status: "MANUAL_REVIEW_REQUIRED",
        invoiceNumber: "FV-INSTALLMENT-AUTH",
        dueDate: new Date("2026-06-01T00:00:00.000Z"),
        amountTotal: 1000,
        currency: "EUR",
        confirmedAt: new Date(),
        automationPausedAt: new Date(),
        automationPauseReason: "AMOUNT_MISMATCH"
      }
    });

    const result = await new CustomerEmailAssistantService({
      ai: customerMessageOnlyAi(async () =>
        customerClassification({
          intent: "REQUEST_STANDARD_INSTALLMENT_PLAN",
          summary: "Customer authorized the standard three-payment installment plan.",
          requestedAction: "štandardný splátkový kalendár"
        })
      ),
      email: emailProvider
    }).process(
      inboundEmail({
        providerId: `${RUN_ID}-installment-authorized`,
        from: "client@example.com",
        to: [signedClarifyAddressForTest(collectionCase.id)],
        subject: "Re: splátky",
        textBody: "Nech platí štandardnou splátkou, suma/3.",
        attachments: []
      })
    );

    expect(result).toMatchObject({
      caseId: collectionCase.id,
      status: "INSTALLMENT_PLAN_SENT",
      intent: "REQUEST_STANDARD_INSTALLMENT_PLAN",
      replySent: true
    });
    const plan = await prisma.installmentPlan.findFirstOrThrow({
      where: { caseId: collectionCase.id },
      include: { payments: { orderBy: { sequence: "asc" } } }
    });
    expect(plan.status).toBe("PROPOSED");
    expect(plan.payments.map((payment) => Number(payment.amount))).toEqual([
      333.33,
      333.33,
      333.34
    ]);
    expect(sent).toHaveLength(2);
    expect(sent[0]).toMatchObject({
      to: ["installment-debtor@example.com"],
      replyTo: [expect.stringMatching(/^reply\+/)]
    });
    expect(sent[0]?.textBody).toContain("štandardný splátkový kalendár");
    expect(sent[1]?.textBody).toContain("poslali dlžníkovi");
  });

  it("does not restore an automation-paused case to parsed for a status question", async () => {
    const sent: SendEmailInput[] = [];
    const emailProvider: EmailProvider = {
      async sendEmail(input) {
        sent.push(input);
        return {
          provider: "fixture",
          providerId: `${RUN_ID}-paused-status-outbound@example.com`
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
        status: "MANUAL_REVIEW_REQUIRED",
        invoiceNumber: "FV-PAUSED-STATUS",
        dueDate: new Date("2026-07-10T00:00:00.000Z"),
        amountTotal: 100,
        currency: "EUR",
        confirmedAt: new Date(),
        automationPausedAt: new Date(),
        automationPauseReason: "AMOUNT_MISMATCH"
      }
    });

    await new CustomerEmailAssistantService({
      ai: customerMessageOnlyAi(async () =>
        customerClassification({
          intent: "ASK_CASE_STATUS",
          summary: "Customer asked for the debt amount."
        })
      ),
      email: emailProvider
    }).process(
      inboundEmail({
        providerId: `${RUN_ID}-paused-status`,
        from: "client@example.com",
        to: [signedClarifyAddressForTest(collectionCase.id)],
        subject: "Re: stav",
        textBody: "Aká je suma dlhu?",
        attachments: []
      })
    );

    const unchanged = await prisma.case.findUniqueOrThrow({
      where: { id: collectionCase.id }
    });
    expect(unchanged.status).toBe("MANUAL_REVIEW_REQUIRED");
    expect(unchanged.automationPauseReason).toBe("AMOUNT_MISMATCH");
    expect(sent[0]?.textBody).toContain("Suma:");
  });

  it("sends a customer-authorized debtor message and can report recent case history", async () => {
    const sent: SendEmailInput[] = [];
    const emailProvider: EmailProvider = {
      async sendEmail(input) {
        sent.push(input);
        return {
          provider: "fixture",
          providerId: `${RUN_ID}-debtor-message-${sent.length}@example.com`
        };
      },
      async parseInbound() {
        throw new Error("not used");
      }
    };
    const debtor = await prisma.debtor.create({
      data: {
        organizationId,
        name: "Message Debtor s.r.o.",
        email: "message-debtor@example.com"
      }
    });
    const collectionCase = await prisma.case.create({
      data: {
        organizationId,
        debtorId: debtor.id,
        sourceType: "EMAIL",
        status: "EMAIL_REMINDER_1_SENT",
        invoiceNumber: "FV-MESSAGE-1",
        dueDate: new Date("2026-06-01T00:00:00.000Z"),
        amountTotal: 900,
        currency: "EUR",
        confirmedAt: new Date(),
        events: {
          create: [
            {
              actorType: "WORKFLOW",
              type: "EMAIL_SENT",
              note: "First reminder sent."
            },
            {
              actorType: "WORKFLOW",
              type: "AUTOMATION_PAUSED",
              note: "Debtor requested custom installments."
            }
          ]
        }
      }
    });

    const service = new CustomerEmailAssistantService({
      ai: customerMessageOnlyAi(async (input) =>
        input.messageText.toLowerCase().includes("hist")
          ? customerClassification({
              intent: "ASK_CASE_HISTORY",
              summary: "Customer asks what actions were taken."
            })
          : customerClassification({
              intent: "REQUEST_SEND_DEBTOR_MESSAGE",
              summary: "Customer asks to send an additional message to debtor.",
              requestedAction: "pošlite doplňujúcu správu",
              replyDraft:
                "Prosíme, potvrďte, či viete uhradiť faktúru do konca týždňa."
            })
      ),
      email: emailProvider
    });

    const sentMessage = await service.process(
      inboundEmail({
        providerId: `${RUN_ID}-debtor-message`,
        from: "client@example.com",
        to: [signedClarifyAddressForTest(collectionCase.id)],
        subject: "Re: čo ďalej",
        textBody: "Pošlite dlžníkovi doplňujúcu správu.",
        attachments: []
      })
    );
    expect(sentMessage).toMatchObject({
      caseId: collectionCase.id,
      intent: "REQUEST_SEND_DEBTOR_MESSAGE",
      replySent: true
    });
    expect(sent[0]).toMatchObject({
      to: ["message-debtor@example.com"],
      replyTo: [expect.stringMatching(/^reply\+/)]
    });
    expect(sent[0]?.textBody).toContain("Prosíme, potvrďte");
    expect(sent[1]?.textBody).toContain("Správu sme podľa vášho pokynu odoslali");

    await service.process(
      inboundEmail({
        providerId: `${RUN_ID}-case-history`,
        from: "client@example.com",
        to: [signedClarifyAddressForTest(collectionCase.id)],
        subject: "Re: história",
        textBody: "Aká je história prípadu?",
        attachments: []
      })
    );
    expect(sent[2]?.textBody).toContain("Posledné kroky:");
    expect(sent[2]?.textBody).toContain("First reminder sent.");
  });

  it("does not send legal-threat debtor messages and explains the block", async () => {
    const sent: SendEmailInput[] = [];
    const emailProvider: EmailProvider = {
      async sendEmail(input) {
        sent.push(input);
        return {
          provider: "fixture",
          providerId: `${RUN_ID}-legal-threat-${sent.length}@example.com`
        };
      },
      async parseInbound() {
        throw new Error("not used");
      }
    };
    const debtor = await prisma.debtor.create({
      data: {
        organizationId,
        name: "Legal Threat Debtor s.r.o.",
        email: "legal-threat-debtor@example.com"
      }
    });
    const collectionCase = await prisma.case.create({
      data: {
        organizationId,
        debtorId: debtor.id,
        sourceType: "EMAIL",
        status: "EMAIL_REMINDER_1_SENT",
        invoiceNumber: "FV-LEGAL-BLOCK",
        dueDate: new Date("2026-06-01T00:00:00.000Z"),
        amountTotal: 900,
        currency: "EUR",
        confirmedAt: new Date()
      }
    });

    const result = await new CustomerEmailAssistantService({
      ai: customerMessageOnlyAi(async () =>
        customerClassification({
          intent: "REQUEST_SEND_DEBTOR_MESSAGE",
          summary:
            "Customer asks to send an additional message to the debtor threatening court action if they do not pay.",
          requestedAction: "Send additional message to debtor",
          customerNote: "Ak nezaplati - pojde na sud",
          replyDraft: "Ak nezaplatí, pôjde na súd.",
          needsHumanReview: true
        })
      ),
      email: emailProvider
    }).process(
      inboundEmail({
        providerId: `${RUN_ID}-legal-threat`,
        from: "client@example.com",
        to: [signedClarifyAddressForTest(collectionCase.id)],
        subject: "Re: rozhodnutie",
        textBody:
          "Pošlite mu doplňujúcu správu: Ak nezaplatí, pôjde na súd.",
        attachments: []
      })
    );

    expect(result).toMatchObject({
      caseId: collectionCase.id,
      intent: "REQUEST_SEND_DEBTOR_MESSAGE",
      replySent: true
    });
    expect(sent).toHaveLength(1);
    expect(sent[0]?.to).toEqual(["client@example.com"]);
    expect(sent[0]?.textBody).toContain("správu dlžníkovi sme neodoslali");
    expect(sent[0]?.textBody).toContain("Ak nezaplatí, pôjde na súd.");
    expect(sent[0]?.textBody).toContain("právnu hrozbu");
  });

  it("stores ambiguous alias emails in a manual-review container case", async () => {
    const sent: SendEmailInput[] = [];
    const emailProvider: EmailProvider = {
      async sendEmail(input) {
        sent.push(input);
        return {
          provider: "fixture",
          providerId: `${RUN_ID}-ambiguous-alias-outbound@example.com`
        };
      },
      async parseInbound() {
        throw new Error("not used");
      }
    };
    const classifyCustomerMessage = vi.fn(async () => ({
      intent: "OTHER" as const,
      confidence: 0.83,
      summary: "Customer sent a message without a unique case reference.",
      extractedInvoiceFields: emptyFields(),
      debtorContactPatch: { email: null, name: null },
      caseReference: {
        caseId: null,
        invoiceNumber: null,
        debtorName: null
      },
      customerNote: "Please check this.",
      requestedAction: null,
      needsHumanReview: false,
      replyDraft: null
    }));
    const service = new CustomerEmailAssistantService({
      ai: customerMessageOnlyAi(classifyCustomerMessage),
      email: emailProvider
    });
    const email = inboundEmail({
      providerId: `${RUN_ID}-ambiguous-alias`,
      subject: "Prosba",
      textBody: "Prosím pozrite sa na moje prípady.",
      attachments: []
    });

    const first = await service.process(email, {
      organizationId,
      matchedAddress: "abc-sro@fakturio.test"
    });
    const second = await service.process(email, {
      organizationId,
      matchedAddress: "abc-sro@fakturio.test"
    });

    expect(first).toMatchObject({
      organizationId,
      duplicate: false,
      status: "MANUAL_REVIEW_REQUIRED",
      replySent: true
    });
    expect(second).toMatchObject({
      caseId: first?.caseId,
      communicationId: first?.communicationId,
      duplicate: true
    });
    expect(sent).toHaveLength(1);
    const communication = await prisma.communication.findUniqueOrThrow({
      where: { id: first?.communicationId ?? "" }
    });
    expect(communication.rawPayload).toMatchObject({
      kind: CUSTOMER_COMMUNICATION_KINDS.unmatchedAssistantMessage,
      reason: "NO_CASE_MATCH"
    });
    expect(
      await prisma.caseEvent.count({
        where: {
          caseId: first?.caseId ?? "",
          type: "MANUAL_REVIEW_REQUIRED"
        }
      })
    ).toBe(1);
  });

  it("splits clearly separate invoice attachments into separate cases", async () => {
    const ai = multiAttachmentAi("SEPARATE_INVOICES");
    const service = new InvoiceIntakeService({ ai, storage });
    const result = await service.createFromEmail({
      organizationId,
      email: inboundEmail({
        providerId: `${RUN_ID}-multi-separate`,
        subject: "Two invoices",
        attachments: [
          attachment("invoice-a.pdf", [11, 12, 13]),
          attachment("invoice-b.pdf", [21, 22, 23])
        ]
      })
    });

    expect(result.cases).toHaveLength(2);
    expect(ai.extractInvoice).toHaveBeenCalledTimes(2);
    expect(result.cases.map((item) => item.status)).toEqual(["PARSED", "PARSED"]);
    expect(
      await prisma.case.count({
        where: { organizationId, sourceType: "EMAIL", invoiceNumber: { startsWith: "TRIAGE-" } }
      })
    ).toBeGreaterThanOrEqual(2);
  });

  it("sends a separate customer clarification for each split invoice that needs review", async () => {
    const sent: SendEmailInput[] = [];
    const emailProvider: EmailProvider = {
      async sendEmail(input) {
        sent.push(input);
        return {
          provider: "fixture",
          providerId: `${RUN_ID}-multi-separate-clarification-${sent.length}@example.com`
        };
      },
      async parseInbound() {
        throw new Error("not used");
      }
    };
    const ai = multiAttachmentAi("SEPARATE_INVOICES");
    let invoiceCounter = 0;
    ai.extractInvoice.mockImplementation(async () => {
      invoiceCounter += 1;
      return {
        invoiceNumber: null,
        issueDate: null,
        dueDate: "2026-07-15",
        amountTotal: 100 + invoiceCounter,
        currency: "EUR",
        supplier: {
          name: "ABC s.r.o.",
          email: "client@example.com",
          ico: null,
          dic: null,
          icDph: null,
          address: null
        },
        debtor: {
          name: `Debtor ${invoiceCounter} s.r.o.`,
          email: `debtor-${invoiceCounter}@example.com`,
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
        confidence: 0.91,
        manualReviewRequired: false,
        warnings: ["Invoice number not visible"],
        rawResult: { invoiceCounter }
      };
    });
    const service = new InvoiceIntakeService({ ai, storage, email: emailProvider });

    const result = await service.createFromEmail({
      organizationId,
      email: inboundEmail({
        providerId: `${RUN_ID}-multi-separate-needs-review`,
        subject: "Two invoices need review",
        from: "client@example.com",
        attachments: [
          attachment("invoice-needs-number-a.pdf", [11, 12, 13, 14]),
          attachment("invoice-needs-number-b.pdf", [21, 22, 23, 24])
        ]
      })
    });

    expect(result.cases).toHaveLength(2);
    expect(result.cases.map((item) => item.status)).toEqual([
      "MANUAL_REVIEW_REQUIRED",
      "MANUAL_REVIEW_REQUIRED"
    ]);
    expect(sent).toHaveLength(2);
    expect(sent[0]?.replyTo).toEqual([expect.stringMatching(/^clarify\+/)]);
    expect(sent[1]?.replyTo).toEqual([expect.stringMatching(/^clarify\+/)]);
    expect(sent[0]?.replyTo?.[0]).not.toEqual(sent[1]?.replyTo?.[0]);
    expect(sent[0]?.subject).toContain("invoice-needs-number-a.pdf");
    expect(sent[1]?.subject).toContain("invoice-needs-number-b.pdf");
    expect(sent[0]?.textBody).toContain("Týka sa dokumentu: invoice-needs-number-a.pdf");
    expect(sent[1]?.textBody).toContain("Týka sa dokumentu: invoice-needs-number-b.pdf");
    expect(
      await prisma.communication.count({
        where: {
          caseId: { in: result.cases.map((item) => item.caseId) },
          direction: "OUTBOUND",
          rawPayload: {
            path: ["kind"],
            equals: CUSTOMER_COMMUNICATION_KINDS.invoiceClarificationRequest
          }
        }
      })
    ).toBe(2);
  });

  it("keeps supporting documents on one case history", async () => {
    const ai = multiAttachmentAi("SINGLE_INVOICE_WITH_SUPPORTING_DOCUMENTS");
    const service = new InvoiceIntakeService({ ai, storage });
    const result = await service.createFromEmail({
      organizationId,
      email: inboundEmail({
        providerId: `${RUN_ID}-multi-supporting`,
        subject: "Invoice with order",
        attachments: [
          attachment("invoice-main.pdf", [31, 32, 33]),
          attachment("objednavka.pdf", [41, 42, 43])
        ]
      })
    });

    expect(result.cases).toHaveLength(1);
    expect(ai.extractInvoice).toHaveBeenCalledTimes(1);
    const caseId = result.cases[0]?.caseId as string;
    expect(
      await prisma.invoiceDocument.count({ where: { caseId } })
    ).toBe(1);
    expect(
      await prisma.communicationAttachment.count({
        where: { communication: { caseId } }
      })
    ).toBe(1);
  });

  it("asks for clarification when multi-attachment triage is ambiguous", async () => {
    const sent: SendEmailInput[] = [];
    const emailProvider: EmailProvider = {
      async sendEmail(input) {
        sent.push(input);
        return {
          provider: "fixture",
          providerId: `${RUN_ID}-multi-ambiguous-outbound@example.com`
        };
      },
      async parseInbound() {
        throw new Error("not used");
      }
    };
    const ai = multiAttachmentAi("NEEDS_CUSTOMER_CLARIFICATION");
    const service = new InvoiceIntakeService({ ai, storage, email: emailProvider });
    const result = await service.createFromEmail({
      organizationId,
      email: inboundEmail({
        providerId: `${RUN_ID}-multi-ambiguous`,
        subject: "Documents",
        attachments: [
          attachment("doklad-1.pdf", [51, 52, 53]),
          attachment("doklad-2.pdf", [61, 62, 63])
        ]
      })
    });
    const duplicate = await service.createFromEmail({
      organizationId,
      email: inboundEmail({
        providerId: `${RUN_ID}-multi-ambiguous`,
        subject: "Documents",
        attachments: [
          attachment("doklad-1.pdf", [51, 52, 53]),
          attachment("doklad-2.pdf", [61, 62, 63])
        ]
      })
    });

    expect(result.cases).toHaveLength(1);
    expect(result.cases[0]?.status).toBe("MANUAL_REVIEW_REQUIRED");
    expect(duplicate.cases[0]?.caseId).toBe(result.cases[0]?.caseId);
    expect(ai.extractInvoice).not.toHaveBeenCalled();
    expect(sent).toHaveLength(1);
    expect(sent[0]?.textBody).toContain("viac dokumentov");
    expect(sent[0]?.replyTo).toEqual([expect.stringMatching(/^clarify\+/)]);
  });

  it("uses customer clarification replies to split saved attachments into cases", async () => {
    const sent: SendEmailInput[] = [];
    const emailProvider: EmailProvider = {
      async sendEmail(input) {
        sent.push(input);
        return {
          provider: "fixture",
          providerId: `${RUN_ID}-multi-recovery-outbound-${sent.length}@example.com`
        };
      },
      async parseInbound() {
        throw new Error("not used");
      }
    };
    const ai = stagedMultiAttachmentAi([
      "NEEDS_CUSTOMER_CLARIFICATION",
      "SEPARATE_INVOICES"
    ]);
    const service = new InvoiceIntakeService({ ai, storage, email: emailProvider });
    const intake = await service.createFromEmail({
      organizationId,
      email: inboundEmail({
        providerId: `${RUN_ID}-multi-recovery`,
        subject: "Documents",
        attachments: [
          attachment("recovery-a.pdf", [71, 72, 73]),
          attachment("recovery-b.pdf", [81, 82, 83])
        ]
      })
    });
    const caseId = intake.cases[0]?.caseId as string;

    const reply = await new CustomerEmailAssistantService({
      ai,
      email: emailProvider,
      storage
    }).process(
      inboundEmail({
        providerId: `${RUN_ID}-multi-recovery-reply`,
        from: "client@example.com",
        to: sent[0]?.replyTo ?? [],
        subject: "Re: documents",
        textBody: "Sú to dve samostatné faktúry: recovery-a.pdf a recovery-b.pdf.",
        attachments: []
      })
    );

    expect(reply).toMatchObject({
      caseId,
      status: "PARSED",
      replySent: true
    });
    expect(ai.extractInvoice).toHaveBeenCalledTimes(2);
    expect(
      await prisma.case.count({
        where: {
          organizationId,
          invoiceNumber: { startsWith: "RECOVERY-" }
        }
      })
    ).toBe(2);
    expect(sent).toHaveLength(2);
    expect(sent[1]?.textBody).toContain("Dokumenty sme rozdelili");
  });
});

function inboundEmail(overrides: Partial<InboundEmail>): InboundEmail {
  return {
    provider: "ses",
    providerId: `${RUN_ID}-message`,
    messageId: null,
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
    attachments: [],
    raw: {},
    ...overrides
  };
}

function attachment(fileName: string, bytes: number[]): InboundEmail["attachments"][number] {
  return {
    fileName,
    mimeType: "application/pdf",
    bytes: Uint8Array.from(bytes)
  };
}

function multiAttachmentAi(
  decision:
    | "SEPARATE_INVOICES"
    | "SINGLE_INVOICE_WITH_SUPPORTING_DOCUMENTS"
    | "NEEDS_CUSTOMER_CLARIFICATION",
  invoicePrefix = "TRIAGE"
): AiProvider & {
  extractInvoice: ReturnType<typeof vi.fn>;
  classifyInvoiceEmailAttachments: ReturnType<typeof vi.fn>;
} {
  let invoiceCounter = 0;
  const extractInvoice = vi.fn(async () => {
    invoiceCounter += 1;
    return {
      invoiceNumber: `${invoicePrefix}-${invoiceCounter}`,
      issueDate: null,
      dueDate: "2026-07-15",
      amountTotal: 100 + invoiceCounter,
      currency: "EUR",
      supplier: {
        name: "ABC s.r.o.",
        email: "client@example.com",
        ico: null,
        dic: null,
        icDph: null,
        address: null
      },
      debtor: {
        name: `Debtor ${invoiceCounter} s.r.o.`,
        email: `debtor-${invoiceCounter}@example.com`,
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
      confidence: 0.96,
      manualReviewRequired: false,
      warnings: [],
      rawResult: { invoiceCounter }
    };
  });
  const classifyInvoiceEmailAttachments = vi.fn(async () => {
    if (decision === "SEPARATE_INVOICES") {
      return {
        decision,
        confidence: 0.95,
        groups: [
          {
            primaryInvoiceAttachmentIndex: 0,
            supportingAttachmentIndexes: [],
            reason: "First document is a separate invoice."
          },
          {
            primaryInvoiceAttachmentIndex: 1,
            supportingAttachmentIndexes: [],
            reason: "Second document is a separate invoice."
          }
        ],
        customerQuestion: null,
        warnings: []
      };
    }
    if (decision === "SINGLE_INVOICE_WITH_SUPPORTING_DOCUMENTS") {
      return {
        decision,
        confidence: 0.94,
        groups: [
          {
            primaryInvoiceAttachmentIndex: 0,
            supportingAttachmentIndexes: [1],
            reason: "First document is the invoice and the second is a supporting document."
          }
        ],
        customerQuestion: null,
        warnings: []
      };
    }
    return {
      decision,
      confidence: 0.62,
      groups: [],
      customerQuestion:
        "Prosím potvrďte, ktoré dokumenty sú samostatné faktúry a ktoré sú prílohy.",
      warnings: ["Ambiguous attachment relationship."]
    };
  });

  return {
    extractInvoice,
    classifyInvoiceEmailAttachments,
    async classifyDebtorReply() {
      throw new Error("not used");
    },
    async classifyCustomerMessage() {
      throw new Error("not used");
    },
    async generateDebtorEmail() {
      throw new Error("not used");
    },
    async summarizeCase() {
      throw new Error("not used");
    }
  };
}

function stagedMultiAttachmentAi(
  decisions: Array<
    | "SEPARATE_INVOICES"
    | "SINGLE_INVOICE_WITH_SUPPORTING_DOCUMENTS"
    | "NEEDS_CUSTOMER_CLARIFICATION"
  >
) {
  let index = 0;
  const ai = multiAttachmentAi(decisions[0] ?? "NEEDS_CUSTOMER_CLARIFICATION", "RECOVERY");
  const classify = vi.fn(async () => {
    const decision = decisions[Math.min(index, decisions.length - 1)] ?? "NEEDS_CUSTOMER_CLARIFICATION";
    index += 1;
    return multiAttachmentAi(decision, "RECOVERY").classifyInvoiceEmailAttachments(
      {} as Parameters<AiProvider["classifyInvoiceEmailAttachments"]>[0]
    );
  });
  return {
    ...ai,
    classifyInvoiceEmailAttachments: classify
  };
}

function emptyFields() {
  return {
    invoiceNumber: null,
    dueDate: null,
    amountTotal: null,
    currency: null,
    debtorName: null,
    debtorEmail: null,
    supplierName: null,
    iban: null,
    variableSymbol: null
  };
}

function customerClassification(
  overrides: Partial<Awaited<ReturnType<AiProvider["classifyCustomerMessage"]>>>
): Awaited<ReturnType<AiProvider["classifyCustomerMessage"]>> {
  return {
    intent: "OTHER",
    confidence: 0.96,
    summary: "Customer message.",
    extractedInvoiceFields: emptyFields(),
    debtorContactPatch: { email: null, name: null },
    caseReference: {
      caseId: null,
      invoiceNumber: null,
      debtorName: null
    },
    customerNote: null,
    requestedAction: null,
    needsHumanReview: false,
    replyDraft: null,
    ...overrides
  };
}

function customerMessageOnlyAi(
  classifyCustomerMessage: AiProvider["classifyCustomerMessage"]
): AiProvider {
  return {
    async extractInvoice() {
      throw new Error("not used");
    },
    async classifyDebtorReply() {
      throw new Error("not used");
    },
    async classifyInvoiceEmailAttachments() {
      throw new Error("not used");
    },
    classifyCustomerMessage,
    async generateDebtorEmail() {
      throw new Error("not used");
    },
    async summarizeCase() {
      throw new Error("not used");
    }
  };
}

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
    async classifyInvoiceEmailAttachments() {
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

function actionRequestAi(): AiProvider {
  return {
    async extractInvoice() {
      throw new Error("not used");
    },
    async classifyDebtorReply() {
      throw new Error("not used");
    },
    async classifyInvoiceEmailAttachments() {
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
