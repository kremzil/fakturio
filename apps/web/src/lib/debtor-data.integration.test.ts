import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@fakturio/db";
import {
  getDashboardDebtorById,
  getDashboardDebtors
} from "./debtor-data";

const runId = `debtor-data-${Date.now().toString(36)}`;
const organizationId = `${runId}-org`;
const otherOrganizationId = `${runId}-other-org`;
const debtorId = `${runId}-debtor`;

beforeAll(async () => {
  await prisma.organization.createMany({
    data: [
      { id: organizationId, name: "Debtor Data Org", slug: organizationId },
      {
        id: otherOrganizationId,
        name: "Other Debtor Data Org",
        slug: otherOrganizationId
      }
    ]
  });
  await prisma.debtor.create({
    data: {
      id: debtorId,
      organizationId,
      name: "Grouped Debtor s.r.o.",
      email: "debtor@example.com",
      ico: "12345678"
    }
  });
  await prisma.case.createMany({
    data: [
      {
        id: `${runId}-open-1`,
        organizationId,
        debtorId,
        status: "WAITING_FOR_DUE_DATE",
        invoiceNumber: "GROUP-1",
        amountTotal: 120,
        currency: "EUR"
      },
      {
        id: `${runId}-open-2`,
        organizationId,
        debtorId,
        status: "EMAIL_REMINDER_1_SENT",
        invoiceNumber: "GROUP-2",
        amountTotal: 80,
        currency: "EUR"
      },
      {
        id: `${runId}-closed`,
        organizationId,
        debtorId,
        status: "CLOSED_PAID",
        invoiceNumber: "GROUP-3",
        amountTotal: 50,
        currency: "EUR",
        closedAt: new Date()
      }
    ]
  });
});

afterAll(async () => {
  await prisma.organization.deleteMany({
    where: { id: { in: [organizationId, otherOrganizationId] } }
  });
  await prisma.$disconnect();
});

describe("dashboard debtor loading", () => {
  it("groups cases and sums only open debt", async () => {
    const debtors = await getDashboardDebtors(organizationId);

    expect(debtors).toEqual([
      expect.objectContaining({
        id: debtorId,
        caseCount: 3,
        openCaseCount: 2,
        closedCaseCount: 1,
        openAmounts: [{ currency: "EUR", amount: 200 }]
      })
    ]);

    const detail = await getDashboardDebtorById(debtorId, organizationId);
    expect(detail?.cases).toHaveLength(3);
    expect(detail?.cases.map((item) => item.invoiceNumber)).toEqual(
      expect.arrayContaining(["GROUP-1", "GROUP-2", "GROUP-3"])
    );
  });

  it("does not expose a debtor across organizations", async () => {
    await expect(
      getDashboardDebtorById(debtorId, otherOrganizationId)
    ).resolves.toBeNull();
    await expect(getDashboardDebtors(otherOrganizationId)).resolves.toEqual([]);
  });
});
