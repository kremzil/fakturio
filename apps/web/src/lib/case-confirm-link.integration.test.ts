import { afterAll, beforeEach, describe, expect, it } from "vitest";
import {
  createCaseConfirmToken,
  requireCaseConfirmTokenSecret
} from "@fakturio/shared";
import { prisma } from "@fakturio/db";
import {
  handleCaseConfirmLinkGet,
  handleCaseConfirmLinkPost
} from "./case-confirm-link";

const RUN_ID = `it-confirm-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
const orgId = `${RUN_ID}-org`;
const caseId = `${RUN_ID}-case`;
const debtorId = `${RUN_ID}-debtor`;
const secret = requireCaseConfirmTokenSecret();

function tokenFor(input: { caseId?: string; organizationId?: string } = {}) {
  return createCaseConfirmToken(
    {
      caseId: input.caseId ?? caseId,
      organizationId: input.organizationId ?? orgId,
      expiresAt: Date.now() + 60_000
    },
    secret
  );
}

function request(method: "GET" | "POST", token = tokenFor()) {
  return new Request(
    `http://localhost/api/cases/${caseId}/confirm-link?token=${token}`,
    { method }
  );
}

beforeEach(async () => {
  await prisma.organization.upsert({
    where: { id: orgId },
    update: {},
    create: { id: orgId, name: "Confirm Link Org", slug: orgId }
  });
  await prisma.debtor.upsert({
    where: { id: debtorId },
    update: { name: "Dlžník s.r.o." },
    create: {
      id: debtorId,
      organizationId: orgId,
      name: "Dlžník s.r.o."
    }
  });
  await prisma.case.upsert({
    where: { id: caseId },
    update: {
      organizationId: orgId,
      debtorId,
      status: "PARSED",
      invoiceNumber: "032026",
      dueDate: new Date("2026-07-15T00:00:00.000Z"),
      amountTotal: 1000,
      currency: "EUR",
      confirmedAt: null,
      confirmedByUserId: null
    },
    create: {
      id: caseId,
      organizationId: orgId,
      debtorId,
      status: "PARSED",
      invoiceNumber: "032026",
      dueDate: new Date("2026-07-15T00:00:00.000Z"),
      amountTotal: 1000,
      currency: "EUR"
    }
  });
});

afterAll(async () => {
  await prisma.organization.deleteMany({ where: { id: orgId } });
  await prisma.$disconnect();
});

describe("case confirmation link", () => {
  it("renders a read-only confirmation page on GET", async () => {
    const response = await handleCaseConfirmLinkGet(request("GET"), caseId);
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(body).toContain("Potvrdiť a spustiť kontrolu");
    const collectionCase = await prisma.case.findUniqueOrThrow({ where: { id: caseId } });
    expect(collectionCase.status).toBe("PARSED");
    expect(collectionCase.confirmedAt).toBeNull();
  });

  it("confirms the case and requests workflow start on POST", async () => {
    const response = await handleCaseConfirmLinkPost(request("POST"), caseId);
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(body).toContain("Prípad bol potvrdený");
    expect(body).toContain("window.close()");
    expect(body).toContain(`/?case=${caseId}`);
    const collectionCase = await prisma.case.findUniqueOrThrow({ where: { id: caseId } });
    expect(collectionCase.status).toBe("WAITING_FOR_DUE_DATE");
    expect(collectionCase.confirmedAt).not.toBeNull();
    expect(
      await prisma.caseEvent.count({
        where: { caseId, type: "WORKFLOW_WAITING" }
      })
    ).toBeGreaterThan(0);
  });
});
