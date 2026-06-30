import { beforeEach, describe, expect, it, vi } from "vitest";
import { EmailProviderError } from "@fakturio/email";

const caseFindUniqueOrThrow = vi.fn();
const caseFindUnique = vi.fn();
const membershipFindFirst = vi.fn();
const caseEventFindFirst = vi.fn();
const caseEventCreate = vi.fn();
const communicationFindUnique = vi.fn();
const communicationFindUniqueOrThrow = vi.fn();
const communicationCreate = vi.fn();
const communicationUpdateMany = vi.fn();
const communicationUpdateManyAndReturn = vi.fn();
const invoiceDocumentFindFirst = vi.fn();
const paymentCheckFindUnique = vi.fn();
const paymentCheckCount = vi.fn();
const paymentCheckCreate = vi.fn();
const txCommunicationUpdateMany = vi.fn();
const txCaseUpdateMany = vi.fn();
const txCaseEventCreate = vi.fn();
const txPaymentCheckUpdateMany = vi.fn();
const transaction = vi.fn();
const sendEmail = vi.fn();
const getObject = vi.fn();

vi.mock("@fakturio/db", () => ({
  prisma: {
    case: {
      findUniqueOrThrow: caseFindUniqueOrThrow,
      findUnique: caseFindUnique
    },
    membership: { findFirst: membershipFindFirst },
    caseEvent: { findFirst: caseEventFindFirst, create: caseEventCreate },
    communication: {
      findUnique: communicationFindUnique,
      findUniqueOrThrow: communicationFindUniqueOrThrow,
      create: communicationCreate,
      updateMany: communicationUpdateMany,
      updateManyAndReturn: communicationUpdateManyAndReturn
    },
    invoiceDocument: {
      findFirst: invoiceDocumentFindFirst
    },
    paymentCheck: {
      findUnique: paymentCheckFindUnique,
      count: paymentCheckCount,
      create: paymentCheckCreate
    },
    $transaction: transaction
  }
}));

vi.mock("@fakturio/email", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@fakturio/email")>();
  return {
    ...actual,
    createEmailProvider: () => ({ sendEmail })
  };
});

vi.mock("@fakturio/storage", () => ({
  createStorageProvider: () => ({ getObject })
}));

const { activities } = await import("./activities");

beforeEach(() => {
  for (const mock of [
    caseFindUniqueOrThrow,
    caseFindUnique,
    membershipFindFirst,
    caseEventFindFirst,
    caseEventCreate,
    communicationFindUnique,
    communicationFindUniqueOrThrow,
    communicationCreate,
    communicationUpdateMany,
    communicationUpdateManyAndReturn,
    invoiceDocumentFindFirst,
    paymentCheckFindUnique,
    paymentCheckCount,
    paymentCheckCreate,
    txCommunicationUpdateMany,
    txCaseUpdateMany,
    txCaseEventCreate,
    txPaymentCheckUpdateMany,
    transaction,
    sendEmail,
    getObject
  ]) {
    mock.mockReset();
  }

  membershipFindFirst.mockResolvedValue({
    user: { email: "owner@example.com" }
  });
  caseEventFindFirst.mockResolvedValue(null);
  communicationUpdateMany.mockResolvedValue({ count: 1 });
  txCommunicationUpdateMany.mockResolvedValue({ count: 1 });
  txCaseUpdateMany.mockResolvedValue({ count: 1 });
  txCaseEventCreate.mockResolvedValue(undefined);
  txPaymentCheckUpdateMany.mockResolvedValue({ count: 1 });
  transaction.mockImplementation(async (callback) =>
    callback({
      communication: { updateMany: txCommunicationUpdateMany },
      case: { updateMany: txCaseUpdateMany },
      caseEvent: { create: txCaseEventCreate },
      paymentCheck: { updateMany: txPaymentCheckUpdateMany }
    })
  );
  process.env.PAYMENT_CHECK_TOKEN_SECRET =
    "test-secret-test-secret-test-secret-1234";
  process.env.INBOUND_REPLY_TOKEN_SECRET =
    "test-inbound-reply-secret-test-12345";
  process.env.INBOUND_REPLY_DOMAIN = "reply.example.com";
  process.env.DEBTOR_FIRST_REMINDER_PAYMENT_DAYS = "10";
  invoiceDocumentFindFirst.mockResolvedValue(null);
  getObject.mockResolvedValue({
    body: Uint8Array.from([1, 2, 3]),
    contentType: "application/pdf",
    sizeBytes: 3
  });
});

describe("worker activity organization isolation", () => {
  it("rejects a case from another organization", async () => {
    caseFindUniqueOrThrow.mockResolvedValue({
      ...caseRecord(),
      organizationId: "org-A"
    });
    await expect(
      activities.loadCaseSnapshot({
        caseId: "case-1",
        organizationId: "org-B"
      })
    ).rejects.toThrow(/belongs to organization org-A/);
  });

  it("returns automation and installment scheduling data", async () => {
    caseFindUniqueOrThrow.mockResolvedValue({
      ...caseRecord(),
      nextActionAt: new Date("2026-06-20T00:00:00.000Z"),
      installmentPlans: [
        {
          payments: [{ id: "installment-1" }]
        }
      ]
    });
    const result = await activities.loadCaseSnapshot({
      caseId: "case-1",
      organizationId: "org-A"
    });
    expect(result).toMatchObject({
      nextActionAt: "2026-06-20T00:00:00.000Z",
      nextInstallmentPaymentId: "installment-1",
      automationPaused: false
    });
  });
});

describe("debtor reminders", () => {
  it("sends reminder 1 and advances the case transactionally", async () => {
    caseFindUniqueOrThrow.mockResolvedValue(caseRecord());
    invoiceDocumentFindFirst.mockResolvedValue({
      storageBucket: "bucket",
      storageKey: "case-1/original.pdf",
      originalName: "original.pdf",
      mimeType: "application/pdf"
    });
    communicationFindUnique.mockResolvedValue(null);
    communicationCreate.mockResolvedValue({ id: "comm-1" });
    sendEmail.mockResolvedValue({
      provider: "fixture",
      providerId: "<message-1@example.com>"
    });

    const result = await activities.sendReminderEmail({
      caseId: "case-1",
      organizationId: "org-A",
      reminderLevel: 1
    });

    expect(result).toBe("SENT");
    expect(sendEmail).toHaveBeenCalledWith(
      expect.objectContaining({
        to: ["debtor@example.com"],
        replyTo: [expect.stringContaining("@reply.example.com")],
        subject: expect.stringContaining("FV-1"),
        attachments: [
          expect.objectContaining({
            fileName: "original.pdf",
            contentType: "application/pdf",
            content: Uint8Array.from([1, 2, 3])
          })
        ]
      })
    );
    expect(getObject).toHaveBeenCalledWith({
      bucket: "bucket",
      key: "case-1/original.pdf"
    });
    expect(txCaseUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: "EMAIL_REMINDER_1_SENT",
          nextActionAt: expect.any(Date)
        })
      })
    );
  });

  it("does not attach the original invoice to reminder 2", async () => {
    caseFindUniqueOrThrow.mockResolvedValue({
      ...caseRecord(),
      status: "EMAIL_REMINDER_1_SENT"
    });
    communicationFindUnique.mockResolvedValue(null);
    communicationCreate.mockResolvedValue({ id: "comm-2" });
    sendEmail.mockResolvedValue({
      provider: "fixture",
      providerId: "<message-2@example.com>"
    });

    const result = await activities.sendReminderEmail({
      caseId: "case-1",
      organizationId: "org-A",
      reminderLevel: 2
    });

    expect(result).toBe("SENT");
    expect(invoiceDocumentFindFirst).not.toHaveBeenCalled();
    expect(sendEmail).toHaveBeenCalledWith(
      expect.not.objectContaining({
        attachments: expect.anything()
      })
    );
  });

  it("does not call the provider when debtor email is missing", async () => {
    caseFindUniqueOrThrow.mockResolvedValue({
      ...caseRecord(),
      debtor: { name: "Debtor", email: null }
    });
    const result = await activities.sendReminderEmail({
      caseId: "case-1",
      organizationId: "org-A",
      reminderLevel: 1
    });
    expect(result).toBe("SKIPPED_MISSING_RECIPIENT");
    expect(sendEmail).not.toHaveBeenCalled();
    expect(txCaseUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          automationPauseReason: "MISSING_DEBTOR_EMAIL",
          automationPausedAt: expect.any(Date),
          nextActionAt: null
        })
      })
    );
  });
});

describe("payment-check outbox", () => {
  beforeEach(() => {
    caseFindUniqueOrThrow.mockResolvedValue(caseRecord());
    paymentCheckFindUnique.mockResolvedValue(null);
    paymentCheckCount.mockResolvedValue(0);
    paymentCheckCreate.mockResolvedValue({
      id: "check-1",
      caseId: "case-1",
      sourceKey: "due-date:case-1:2026-06-02",
      reason: "DUE_DATE",
      sequence: 1,
      status: "PENDING",
      expectedAmount: 100,
      currency: "EUR",
      installmentPaymentId: null,
      expiresAt: new Date(Date.now() + 60_000)
    });
    communicationFindUnique.mockResolvedValue(null);
    communicationCreate.mockResolvedValue({ id: "comm-1" });
  });

  it("creates a concrete payment check and sends signed links", async () => {
    sendEmail.mockResolvedValue({
      provider: "fixture",
      providerId: "message-1"
    });
    const result = await activities.sendPaymentCheckEmail({
      caseId: "case-1",
      organizationId: "org-A",
      sourceKey: "due-date:case-1:2026-06-02",
      reason: "DUE_DATE"
    });
    expect(result).toEqual({ paymentCheckId: "check-1" });
    expect(sendEmail).toHaveBeenCalledWith(
      expect.objectContaining({
        to: ["owner@example.com"],
        textBody: expect.stringContaining("payment-check/paid?token=")
      })
    );
    expect(txPaymentCheckUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: "check-1" }),
        data: expect.objectContaining({
          status: "SENT",
          communicationId: "comm-1"
        })
      })
    );
  });

  it("marks the outbox row failed when the provider fails", async () => {
    sendEmail.mockRejectedValue(new Error("SES down"));
    await expect(
      activities.sendPaymentCheckEmail({
        caseId: "case-1",
        organizationId: "org-A",
        sourceKey: "due-date:case-1:2026-06-02",
        reason: "DUE_DATE"
      })
    ).rejects.toThrow(/SES down/);
    expect(communicationUpdateMany).toHaveBeenCalledWith({
      where: {
        id: "comm-1",
        sendLeaseId: expect.any(String)
      },
      data: {
        status: "FAILED",
        sendLeaseId: null,
        sendLeaseUntil: null
      }
    });
  });

  it("does not resend an already delivered check", async () => {
    communicationFindUnique.mockResolvedValue({
      id: "comm-1",
      status: "SENT"
    });
    const result = await activities.sendPaymentCheckEmail({
      caseId: "case-1",
      organizationId: "org-A",
      sourceKey: "due-date:case-1:2026-06-02",
      reason: "DUE_DATE"
    });
    expect(result).toEqual({ paymentCheckId: "check-1" });
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it("pauses instead of retry-looping when no customer email exists", async () => {
    membershipFindFirst.mockResolvedValue(null);

    const result = await activities.sendPaymentCheckEmail({
      caseId: "case-1",
      organizationId: "org-A",
      sourceKey: "due-date:case-1:2026-06-02",
      reason: "DUE_DATE"
    });

    expect(result).toBeNull();
    expect(sendEmail).not.toHaveBeenCalled();
    expect(txCaseUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          automationPauseReason: "MISSING_CUSTOMER_EMAIL",
          automationPausedAt: expect.any(Date),
          nextActionAt: null
        })
      })
    );
  });

  it("pauses instead of retry-looping on permanent customer email rejection", async () => {
    sendEmail.mockRejectedValue(
      new EmailProviderError({
        code: "MESSAGE_REJECTED",
        provider: "ses",
        message: "SES rejected the message.",
        retryable: false
      })
    );

    const result = await activities.sendPaymentCheckEmail({
      caseId: "case-1",
      organizationId: "org-A",
      sourceKey: "due-date:case-1:2026-06-02",
      reason: "DUE_DATE"
    });

    expect(result).toBeNull();
    expect(txCaseUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          automationPauseReason: "CUSTOMER_EMAIL_REJECTED",
          automationPausedAt: expect.any(Date),
          nextActionAt: null
        })
      })
    );
  });
});

describe("debtor replies", () => {
  it("sends the original invoice when the debtor asks for a copy", async () => {
    const collectionCase = caseRecord();
    communicationFindUniqueOrThrow.mockResolvedValue({
      id: "reply-1",
      caseId: "case-1",
      fromAddress: "debtor@example.com",
      textBody: "Dobrý deň, prosím pošlite faktúru v PDF.",
      htmlBody: null,
      receivedAt: new Date("2026-06-10T10:00:00.000Z"),
      createdAt: new Date("2026-06-10T10:00:00.000Z"),
      rawPayload: {},
      aiClassification: null,
      case: {
        ...collectionCase,
        installmentPlans: []
      }
    });
    invoiceDocumentFindFirst.mockResolvedValue({
      storageBucket: "bucket",
      storageKey: "case-1/original.pdf",
      originalName: "original.pdf",
      mimeType: "application/pdf"
    });
    communicationFindUnique.mockResolvedValue(null);
    communicationCreate.mockResolvedValue({ id: "comm-copy" });
    sendEmail.mockResolvedValue({
      provider: "fixture",
      providerId: "<copy@example.com>"
    });

    const result = await activities.processDebtorReply({
      caseId: "case-1",
      organizationId: "org-A",
      communicationId: "reply-1"
    });

    expect(result).toMatchObject({
      kind: "INVOICE_COPY_SENT",
      communicationId: "reply-1"
    });
    expect(sendEmail).toHaveBeenCalledWith(
      expect.objectContaining({
        to: ["debtor@example.com"],
        subject: expect.stringContaining("FV-1"),
        attachments: [
          expect.objectContaining({
            fileName: "original.pdf",
            contentType: "application/pdf",
            content: Uint8Array.from([1, 2, 3])
          })
        ]
      })
    );
    expect(txCaseUpdateMany).not.toHaveBeenCalled();
    expect(caseEventCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          type: "DEBTOR_REPLY_ACTIONED",
          note: expect.stringContaining("Original invoice original.pdf sent")
        })
      })
    );
  });
});

function caseRecord() {
  return {
    id: "case-1",
    organizationId: "org-A",
    status: "OVERDUE",
    dueDate: new Date("2026-06-02T00:00:00.000Z"),
    invoiceNumber: "FV-1",
    amountTotal: 100,
    currency: "EUR",
    subjectNote: "Services",
    supplierSnapshot: {
      name: "Creditor s.r.o.",
      address: "Main 1",
      ico: "12345678"
    },
    paymentSnapshot: {
      iban: "SK1211000000002941987654",
      variableSymbol: "2026001"
    },
    debtor: { name: "Debtor s.r.o.", email: "debtor@example.com" },
    customer: null,
    organization: { name: "Org A" },
    installmentPlans: [],
    confirmedByUserId: "user-1",
    nextActionAt: null,
    automationPausedAt: null
  };
}
