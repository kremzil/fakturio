import { beforeEach, describe, expect, it, vi } from "vitest";

const findUniqueOrThrow = vi.fn();
const userFindUnique = vi.fn();
const membershipFindFirst = vi.fn();
const communicationFindUnique = vi.fn();
const communicationCreate = vi.fn();
const communicationUpdateMany = vi.fn();
const communicationUpdateManyAndReturn = vi.fn();
const caseEventCreate = vi.fn();
const txCommunicationUpdateMany = vi.fn();
const txCaseEventCreate = vi.fn();
const transaction = vi.fn();
const sendEmail = vi.fn();

vi.mock("@fakturio/db", () => ({
  prisma: {
    case: { findUniqueOrThrow },
    user: { findUnique: userFindUnique },
    membership: { findFirst: membershipFindFirst },
    caseEvent: { create: caseEventCreate },
    communication: {
      findUnique: communicationFindUnique,
      create: communicationCreate,
      updateMany: communicationUpdateMany,
      updateManyAndReturn: communicationUpdateManyAndReturn
    },
    $transaction: transaction
  }
}));

vi.mock("@fakturio/email", () => ({
  createEmailProvider: () => ({ sendEmail })
}));

const { activities } = await import("./activities");

beforeEach(() => {
  findUniqueOrThrow.mockReset();
  userFindUnique.mockReset();
  membershipFindFirst.mockReset();
  communicationFindUnique.mockReset();
  communicationCreate.mockReset();
  communicationUpdateMany.mockReset();
  communicationUpdateManyAndReturn.mockReset();
  caseEventCreate.mockReset();
  txCommunicationUpdateMany.mockReset();
  txCaseEventCreate.mockReset();
  transaction.mockReset();
  sendEmail.mockReset();
  communicationUpdateMany.mockResolvedValue({ count: 1 });
  communicationUpdateManyAndReturn.mockResolvedValue([{ id: "comm-1" }]);
  txCommunicationUpdateMany.mockResolvedValue({ count: 1 });
  txCaseEventCreate.mockResolvedValue(undefined);
  transaction.mockImplementation(async (callback) =>
    callback({
      communication: { updateMany: txCommunicationUpdateMany },
      caseEvent: { create: txCaseEventCreate }
    })
  );
  process.env.PAYMENT_CHECK_TOKEN_SECRET = "test-secret-test-secret-test-secret-1234";
});

describe("worker activity organization isolation", () => {
  it("rejects loadCaseSnapshot when the case belongs to a different organization", async () => {
    findUniqueOrThrow.mockResolvedValue({
      id: "case-1",
      organizationId: "org-A",
      status: "WAITING_FOR_DUE_DATE",
      dueDate: null,
      invoiceNumber: null,
      amountTotal: null,
      currency: null,
      confirmedByUserId: null,
      debtor: null
    });

    await expect(activities.loadCaseSnapshot({ caseId: "case-1", organizationId: "org-B" })).rejects.toThrow(
      /belongs to organization org-A but workflow expected org-B/
    );
  });

  it("returns a snapshot when the organization matches", async () => {
    findUniqueOrThrow.mockResolvedValue({
      id: "case-1",
      organizationId: "org-A",
      status: "WAITING_FOR_DUE_DATE",
      dueDate: new Date("2026-06-02T00:00:00.000Z"),
      invoiceNumber: "FV-1",
      amountTotal: null,
      currency: "EUR",
      confirmedByUserId: null,
      debtor: { name: "Dlžník s.r.o.", email: null }
    });
    membershipFindFirst.mockResolvedValue(null);

    const snapshot = await activities.loadCaseSnapshot({ caseId: "case-1", organizationId: "org-A" });
    expect(snapshot).toMatchObject({ id: "case-1", status: "WAITING_FOR_DUE_DATE", invoiceNumber: "FV-1" });
  });
});

describe("sendPaymentCheckEmail outbox idempotency", () => {
  function arrangeCase(): void {
    findUniqueOrThrow.mockResolvedValue({
      id: "case-1",
      organizationId: "org-A",
      status: "OVERDUE",
      dueDate: new Date("2026-06-02T00:00:00.000Z"),
      invoiceNumber: "FV-1",
      amountTotal: 100,
      currency: "EUR",
      confirmedByUserId: "user-1",
      debtor: { name: "Dlžník s.r.o.", email: "debtor@example.com" },
      organization: { name: "Org A" }
    });
    membershipFindFirst.mockResolvedValue({ user: { email: "owner@example.com" } });
  }

  it("marks the claim FAILED and rethrows when sending fails after the claim is created", async () => {
    arrangeCase();
    communicationFindUnique.mockResolvedValue(null);
    communicationCreate.mockResolvedValue({ id: "comm-1" });
    sendEmail.mockRejectedValue(new Error("SES down"));

    await expect(
      activities.sendPaymentCheckEmail({ caseId: "case-1", organizationId: "org-A" })
    ).rejects.toThrow(/SES down/);

    expect(communicationUpdateMany).toHaveBeenCalledWith({
      where: { id: "comm-1", sendLeaseId: expect.any(String) },
      data: { status: "FAILED", sendLeaseId: null, sendLeaseUntil: null }
    });
    // No phantom "sent": neither the confirming transaction nor the audit event ran.
    expect(transaction).not.toHaveBeenCalled();
    expect(caseEventCreate).not.toHaveBeenCalled();
  });

  it("resends and confirms when a prior attempt left a DRAFT claim", async () => {
    arrangeCase();
    communicationFindUnique.mockResolvedValue({ id: "comm-1", status: "DRAFT" });
    sendEmail.mockResolvedValue({ provider: "mock", providerId: "prov-1" });

    await activities.sendPaymentCheckEmail({ caseId: "case-1", organizationId: "org-A" });

    // The existing claim is reused (no new claim) and the email is actually resent.
    expect(communicationCreate).not.toHaveBeenCalled();
    expect(sendEmail).toHaveBeenCalledTimes(1);
    expect(communicationUpdateManyAndReturn).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ idempotencyKey: "payment-check:case-1:2026-06-02" }),
        data: expect.objectContaining({
          status: "DRAFT",
          sendLeaseId: expect.any(String),
          toAddress: "owner@example.com",
          textBody: expect.stringContaining("Platba prišla:")
        })
      })
    );
    expect(txCommunicationUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: "comm-1", sendLeaseId: expect.any(String) }),
        data: expect.objectContaining({ status: "SENT", sendLeaseId: null, sendLeaseUntil: null })
      })
    );
    expect(transaction).toHaveBeenCalledTimes(1);
  });

  it("does not resend when a prior attempt already delivered (SENT)", async () => {
    arrangeCase();
    communicationFindUnique.mockResolvedValue({ id: "comm-1", status: "SENT" });

    await activities.sendPaymentCheckEmail({ caseId: "case-1", organizationId: "org-A" });

    expect(communicationCreate).not.toHaveBeenCalled();
    expect(sendEmail).not.toHaveBeenCalled();
    expect(transaction).not.toHaveBeenCalled();
  });

  it("allows only one concurrent activity attempt to send", async () => {
    arrangeCase();
    communicationFindUnique.mockResolvedValue({ id: "comm-1", status: "DRAFT" });
    communicationUpdateManyAndReturn.mockResolvedValueOnce([{ id: "comm-1" }]).mockResolvedValueOnce([]);
    sendEmail.mockResolvedValue({ provider: "mock", providerId: "prov-1" });

    const results = await Promise.allSettled([
      activities.sendPaymentCheckEmail({ caseId: "case-1", organizationId: "org-A" }),
      activities.sendPaymentCheckEmail({ caseId: "case-1", organizationId: "org-A" })
    ]);

    expect(sendEmail).toHaveBeenCalledTimes(1);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
  });

  it("rethrows when the confirming transaction fails after a successful send", async () => {
    arrangeCase();
    communicationFindUnique.mockResolvedValue(null);
    communicationCreate.mockResolvedValue({ id: "comm-1" });
    sendEmail.mockResolvedValue({ provider: "mock", providerId: "prov-1" });
    transaction.mockRejectedValue(new Error("tx failed"));

    await expect(
      activities.sendPaymentCheckEmail({ caseId: "case-1", organizationId: "org-A" })
    ).rejects.toThrow(/tx failed/);

    // The row was never marked SENT, so a Temporal retry will see DRAFT and resend.
    expect(sendEmail).toHaveBeenCalledTimes(1);
    expect(transaction).toHaveBeenCalledTimes(1);
  });
});
