import { afterAll, beforeEach, describe, expect, it } from "vitest";
import {
  CASE_EVENT_TYPES,
  createPaymentCheckToken,
  type PaymentCheckAction,
  requirePaymentCheckTokenSecret
} from "@fakturio/shared";
import { prisma } from "@fakturio/db";
import { handlePaymentCheckGet, handlePaymentCheckPost } from "./payment-check";

/**
 * Route-level integration tests for the public payment-check flow against live Postgres.
 *
 * Covers the gaps that pure unit tests cannot catch:
 *  - cross-tenant access returns 404 (token bound to the wrong organization sees nothing),
 *  - GET never mutates the case,
 *  - concurrent POSTs cannot double-apply or regress the case status.
 *
 * Run via `npm run test:integration` with the docker compose stack up.
 */

const RUN_ID = `it-pc-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
const orgId = `${RUN_ID}-org`;
const otherOrgId = `${RUN_ID}-other-org`;
const caseId = `${RUN_ID}-case`;

const secret = requirePaymentCheckTokenSecret();

function tokenFor(action: PaymentCheckAction, organizationId: string): string {
  return createPaymentCheckToken(
    { caseId, organizationId, action, expiresAt: Date.now() + 60_000 },
    secret
  );
}

function buildRequest(method: "GET" | "POST", action: PaymentCheckAction, token: string): Request {
  const path = action === "PAID" ? "paid" : "not-paid";
  return new Request(`http://localhost/api/cases/${caseId}/payment-check/${path}?token=${token}`, { method });
}

async function resetCase(status: string) {
  await prisma.caseEvent.deleteMany({ where: { caseId } });
  await prisma.case.update({ where: { id: caseId }, data: { status: status as never, closedAt: null } });
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
    update: { status: "WAITING_FOR_DUE_DATE", closedAt: null, invoiceNumber: "INV-PC-1" },
    create: {
      id: caseId,
      organizationId: orgId,
      status: "WAITING_FOR_DUE_DATE",
      invoiceNumber: "INV-PC-1"
    }
  });
  await prisma.caseEvent.deleteMany({ where: { caseId } });
});

afterAll(async () => {
  await prisma.organization.deleteMany({ where: { id: { in: [orgId, otherOrgId] } } });
  await prisma.$disconnect();
});

describe("payment-check route flow (integration)", () => {
  it("GET renders the landing page without mutating the case", async () => {
    const response = await handlePaymentCheckGet(buildRequest("GET", "PAID", tokenFor("PAID", orgId)), caseId, "PAID");
    expect(response.status).toBe(200);

    const after = await prisma.case.findUnique({ where: { id: caseId }, select: { status: true } });
    expect(after?.status).toBe("WAITING_FOR_DUE_DATE");

    const eventCount = await prisma.caseEvent.count({ where: { caseId } });
    expect(eventCount).toBe(0);
  });

  it("GET with a token bound to another organization returns 404 (cross-tenant)", async () => {
    const response = await handlePaymentCheckGet(
      buildRequest("GET", "PAID", tokenFor("PAID", otherOrgId)),
      caseId,
      "PAID"
    );

    expect(response.status).toBe(404);

    const after = await prisma.case.findUnique({ where: { id: caseId }, select: { status: true } });
    expect(after?.status).toBe("WAITING_FOR_DUE_DATE");
  });

  it("concurrent identical PAID POSTs apply exactly once", async () => {
    const token = tokenFor("PAID", orgId);
    const responses = await Promise.all(
      Array.from({ length: 5 }, () => handlePaymentCheckPost(buildRequest("POST", "PAID", token), caseId, "PAID"))
    );

    expect(responses.every((r) => r.status === 200)).toBe(true);

    const after = await prisma.case.findUnique({ where: { id: caseId }, select: { status: true } });
    expect(after?.status).toBe("CLOSED_PAID");

    // The conditional update must prevent the transition from being applied more than once.
    const confirmations = await prisma.caseEvent.count({
      where: { caseId, type: CASE_EVENT_TYPES.paymentReceivedConfirmed }
    });
    expect(confirmations).toBe(1);
  });

  it("PAID then NOT_PAID does not regress a closed-paid case", async () => {
    await resetCase("WAITING_FOR_DUE_DATE");

    const paid = await handlePaymentCheckPost(buildRequest("POST", "PAID", tokenFor("PAID", orgId)), caseId, "PAID");
    expect(paid.status).toBe(200);

    const notPaid = await handlePaymentCheckPost(
      buildRequest("POST", "NOT_PAID", tokenFor("NOT_PAID", orgId)),
      caseId,
      "NOT_PAID"
    );
    // NOT_PAID after CLOSED_PAID is a conflict, never a silent regression to OVERDUE.
    expect(notPaid.status).toBe(409);

    const after = await prisma.case.findUnique({ where: { id: caseId }, select: { status: true } });
    expect(after?.status).toBe("CLOSED_PAID");
  });

  it("concurrent PAID and NOT_PAID always converge to CLOSED_PAID", async () => {
    await resetCase("WAITING_FOR_DUE_DATE");

    const [paid] = await Promise.all([
      handlePaymentCheckPost(buildRequest("POST", "PAID", tokenFor("PAID", orgId)), caseId, "PAID"),
      handlePaymentCheckPost(buildRequest("POST", "NOT_PAID", tokenFor("NOT_PAID", orgId)), caseId, "NOT_PAID")
    ]);

    // Regardless of interleaving the case must end CLOSED_PAID: PAID progresses from OVERDUE,
    // and NOT_PAID after CLOSED_PAID is a conflict (never a regression). Accepting OVERDUE here
    // would let the original race condition slip through, so we assert the strong invariant.
    const after = await prisma.case.findUnique({ where: { id: caseId }, select: { status: true } });
    expect(after?.status).toBe("CLOSED_PAID");
    expect(paid.status).toBe(200);
  });
});
