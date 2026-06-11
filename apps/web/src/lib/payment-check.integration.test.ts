import { createHmac } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import {
  CASE_EVENT_TYPES,
  createPaymentCheckToken,
  type PaymentCheckAction,
  requirePaymentCheckTokenSecret
} from "@fakturio/shared";
import { prisma } from "@fakturio/db";
import { handlePaymentCheckGet, handlePaymentCheckPost } from "./payment-check";
import { activities } from "../../../worker/src/activities";

const RUN_ID = `it-pc-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
const orgId = `${RUN_ID}-org`;
const otherOrgId = `${RUN_ID}-other-org`;
const caseId = `${RUN_ID}-case`;
const secret = requirePaymentCheckTokenSecret();
let paymentCheckId = "";

function tokenFor(
  action: PaymentCheckAction,
  organizationId = orgId,
  checkId = paymentCheckId
): string {
  return createPaymentCheckToken(
    {
      paymentCheckId: checkId,
      caseId,
      organizationId,
      action,
      expiresAt: Date.now() + 60_000
    },
    secret
  );
}

function buildRequest(
  method: "GET" | "POST",
  action: PaymentCheckAction,
  token: string
): Request {
  const path = action === "PAID" ? "paid" : "not-paid";
  return new Request(
    `http://localhost/api/cases/${caseId}/payment-check/${path}?token=${token}`,
    { method }
  );
}

function legacyTokenFor(action: PaymentCheckAction): string {
  const payload = Buffer.from(
    JSON.stringify({
      version: 1,
      purpose: "payment-check",
      caseId,
      organizationId: orgId,
      action,
      expiresAt: Date.now() + 60_000
    }),
    "utf8"
  ).toString("base64url");
  const signature = createHmac("sha256", secret)
    .update(payload)
    .digest("base64url");
  return `${payload}.${signature}`;
}

beforeEach(async () => {
  await prisma.organization.upsert({
    where: { id: orgId },
    update: {},
    create: { id: orgId, name: "PC Org", slug: orgId }
  });
  await prisma.organization.upsert({
    where: { id: otherOrgId },
    update: {},
    create: { id: otherOrgId, name: "PC Other Org", slug: otherOrgId }
  });
  await prisma.case.upsert({
    where: { id: caseId },
    update: {
      status: "WAITING_FOR_DUE_DATE",
      closedAt: null,
      invoiceNumber: "INV-PC-1",
      nextActionAt: null
    },
    create: {
      id: caseId,
      organizationId: orgId,
      status: "WAITING_FOR_DUE_DATE",
      invoiceNumber: "INV-PC-1"
    }
  });
  await prisma.workflowCommand.deleteMany({ where: { caseId } });
  await prisma.caseEvent.deleteMany({ where: { caseId } });
  await prisma.paymentCheck.deleteMany({ where: { caseId } });
  await prisma.installmentPlan.deleteMany({ where: { caseId } });
  const check = await prisma.paymentCheck.create({
    data: {
      caseId,
      sourceKey: `${RUN_ID}-${Date.now()}-${Math.random()}`,
      reason: "DUE_DATE",
      sequence: 1,
      status: "SENT",
      expectedAmount: 100,
      currency: "EUR",
      expiresAt: new Date(Date.now() + 60_000)
    }
  });
  paymentCheckId = check.id;
});

afterAll(async () => {
  await prisma.organization.deleteMany({
    where: { id: { in: [orgId, otherOrgId] } }
  });
  await prisma.$disconnect();
});

describe("payment-check route flow", () => {
  it("GET renders without mutating the payment check", async () => {
    const response = await handlePaymentCheckGet(
      buildRequest("GET", "PAID", tokenFor("PAID")),
      caseId,
      "PAID"
    );
    expect(response.status).toBe(200);
    const check = await prisma.paymentCheck.findUniqueOrThrow({
      where: { id: paymentCheckId }
    });
    expect(check.status).toBe("SENT");
  });

  it("returns 404 for a token bound to another organization", async () => {
    const response = await handlePaymentCheckGet(
      buildRequest("GET", "PAID", tokenFor("PAID", otherOrgId)),
      caseId,
      "PAID"
    );
    expect(response.status).toBe(404);
  });

  it("applies concurrent identical responses exactly once", async () => {
    const token = tokenFor("NOT_PAID");
    const responses = await Promise.all(
      Array.from({ length: 5 }, () =>
        handlePaymentCheckPost(
          buildRequest("POST", "NOT_PAID", token),
          caseId,
          "NOT_PAID"
        )
      )
    );
    expect(responses.map((response) => response.status)).toEqual([
      200,
      200,
      200,
      200,
      200
    ]);
    const check = await prisma.paymentCheck.findUniqueOrThrow({
      where: { id: paymentCheckId }
    });
    expect(check.status).toBe("RESOLVED_NOT_PAID");
    expect(
      await prisma.caseEvent.count({
        where: {
          caseId,
          type: CASE_EVENT_TYPES.paymentNotReceivedConfirmed
        }
      })
    ).toBe(1);
    expect(await prisma.workflowCommand.count({ where: { caseId } })).toBe(1);
  });

  it("rejects the opposite result after a check is resolved", async () => {
    const paid = await handlePaymentCheckPost(
      buildRequest("POST", "PAID", tokenFor("PAID")),
      caseId,
      "PAID"
    );
    expect(paid.status).toBe(200);

    const notPaid = await handlePaymentCheckPost(
      buildRequest("POST", "NOT_PAID", tokenFor("NOT_PAID")),
      caseId,
      "NOT_PAID"
    );
    expect(notPaid.status).toBe(409);
    expect(
      (
        await prisma.paymentCheck.findUniqueOrThrow({
          where: { id: paymentCheckId }
        })
      ).status
    ).toBe("RESOLVED_PAID");
  });

  it("keeps version 1 links operational during the token rollout", async () => {
    const response = await handlePaymentCheckPost(
      buildRequest("POST", "PAID", legacyTokenFor("PAID")),
      caseId,
      "PAID"
    );

    expect(response.status).toBe(200);
    expect(
      (await prisma.case.findUniqueOrThrow({ where: { id: caseId } })).status
    ).toBe("CLOSED_PAID");
    expect(
      (
        await prisma.paymentCheck.findUniqueOrThrow({
          where: { id: paymentCheckId }
        })
      ).status
    ).toBe("SENT");
  });

  it.each([1, 2])(
    "marks installment %s paid and schedules the next installment",
    async (sequence) => {
      const plan = await createInstallmentPlan(sequence);
      const current = plan.payments.find(
        (payment) => payment.sequence === sequence
      )!;
      paymentCheckId = await replaceWithInstallmentCheck(current.id, sequence);

      const response = await handlePaymentCheckPost(
        buildRequest("POST", "PAID", tokenFor("PAID")),
        caseId,
        "PAID"
      );

      expect(response.status).toBe(200);
      expect(
        (
          await prisma.installmentPayment.findUniqueOrThrow({
            where: { id: current.id }
          })
        ).status
      ).toBe("PAID");
      const next = plan.payments.find(
        (payment) => payment.sequence === sequence + 1
      )!;
      const collectionCase = await prisma.case.findUniqueOrThrow({
        where: { id: caseId }
      });
      expect(collectionCase.status).toBe("INSTALLMENT_ACTIVE");
      expect(collectionCase.nextActionAt?.toISOString()).toBe(
        next.dueDate.toISOString()
      );
    }
  );

  it("closes the case after the third installment is confirmed paid", async () => {
    const plan = await createInstallmentPlan(3);
    const third = plan.payments.find((payment) => payment.sequence === 3)!;
    paymentCheckId = await replaceWithInstallmentCheck(third.id, 3);

    const response = await handlePaymentCheckPost(
      buildRequest("POST", "PAID", tokenFor("PAID")),
      caseId,
      "PAID"
    );

    expect(response.status).toBe(200);
    expect(
      (await prisma.installmentPlan.findUniqueOrThrow({ where: { id: plan.id } }))
        .status
    ).toBe("COMPLETED");
    expect(
      (await prisma.case.findUniqueOrThrow({ where: { id: caseId } })).status
    ).toBe("CLOSED_PAID");
  });

  it("breaks the plan, sends the workflow command and creates CALL_REQUIRED", async () => {
    const plan = await createInstallmentPlan(1);
    const first = plan.payments[0];
    paymentCheckId = await replaceWithInstallmentCheck(first.id, 1);

    const response = await handlePaymentCheckPost(
      buildRequest("POST", "NOT_PAID", tokenFor("NOT_PAID")),
      caseId,
      "NOT_PAID"
    );
    expect(response.status).toBe(200);
    expect(
      (await prisma.installmentPlan.findUniqueOrThrow({ where: { id: plan.id } }))
        .status
    ).toBe("BROKEN");
    expect(
      (await prisma.case.findUniqueOrThrow({ where: { id: caseId } })).status
    ).toBe("INSTALLMENT_BROKEN");

    await activities.sendInstallmentBrokenEmail({
      caseId,
      organizationId: orgId,
      paymentCheckId
    });
    expect(
      await prisma.caseEvent.count({
        where: { caseId, type: CASE_EVENT_TYPES.callRequired }
      })
    ).toBe(1);
  });

  it("rejects an installment link after the case was closed", async () => {
    const plan = await createInstallmentPlan(1);
    const first = plan.payments[0];
    paymentCheckId = await replaceWithInstallmentCheck(first.id, 1);
    await prisma.case.update({
      where: { id: caseId },
      data: { status: "CLOSED_CANCELLED", closedAt: new Date() }
    });

    const response = await handlePaymentCheckPost(
      buildRequest("POST", "PAID", tokenFor("PAID")),
      caseId,
      "PAID"
    );

    expect(response.status).toBe(409);
    expect(
      (await prisma.case.findUniqueOrThrow({ where: { id: caseId } })).status
    ).toBe("CLOSED_CANCELLED");
    expect(
      (await prisma.installmentPlan.findUniqueOrThrow({ where: { id: plan.id } }))
        .status
    ).toBe("ACTIVE");
    expect(
      (
        await prisma.installmentPayment.findUniqueOrThrow({
          where: { id: first.id }
        })
      ).status
    ).toBe("PENDING");
    expect(
      (
        await prisma.paymentCheck.findUniqueOrThrow({
          where: { id: paymentCheckId }
        })
      ).status
    ).toBe("SENT");
  });
});

async function createInstallmentPlan(currentSequence: number) {
  await prisma.case.update({
    where: { id: caseId },
    data: { status: "INSTALLMENT_ACTIVE" }
  });
  return prisma.installmentPlan.create({
    data: {
      caseId,
      status: "ACTIVE",
      totalAmount: 100,
      currency: "EUR",
      acceptedAt: new Date(),
      payments: {
        create: [1, 2, 3].map((sequence) => ({
          sequence,
          amount: sequence === 3 ? 33.34 : 33.33,
          dueDate: new Date(
            `2026-0${sequence + 6}-01T00:00:00.000Z`
          ),
          status: sequence < currentSequence ? "PAID" : "PENDING",
          paidAt: sequence < currentSequence ? new Date() : null
        }))
      }
    },
    include: { payments: { orderBy: { sequence: "asc" } } }
  });
}

async function replaceWithInstallmentCheck(
  installmentPaymentId: string,
  sequence: number
): Promise<string> {
  await prisma.paymentCheck.deleteMany({ where: { caseId } });
  const check = await prisma.paymentCheck.create({
    data: {
      caseId,
      installmentPaymentId,
      sourceKey: `${RUN_ID}-installment-${sequence}-${Date.now()}`,
      reason: "INSTALLMENT_PAYMENT",
      sequence,
      status: "SENT",
      expectedAmount: sequence === 3 ? 33.34 : 33.33,
      currency: "EUR",
      expiresAt: new Date(Date.now() + 60_000)
    }
  });
  return check.id;
}
