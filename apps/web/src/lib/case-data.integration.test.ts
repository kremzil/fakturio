import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@fakturio/db";
import { getDashboardCaseById, getDashboardCases } from "./case-data";

const runId = `case-data-${Date.now().toString(36)}`;
const organizationId = `${runId}-org`;
const caseId = `${runId}-case`;

beforeAll(async () => {
  await prisma.organization.create({
    data: { id: organizationId, name: "Case Data Org", slug: organizationId }
  });
  await prisma.case.create({
    data: {
      id: caseId,
      organizationId,
      status: "EMAIL_REMINDER_1_SENT",
      confirmedAt: new Date(),
      invoiceNumber: "HISTORY-1",
      amountTotal: 100,
      currency: "EUR"
    }
  });
  await prisma.caseEvent.createMany({
    data: Array.from({ length: 35 }, (_, index) => ({
      caseId,
      actorType: "SYSTEM" as const,
      type: "HISTORY_EVENT",
      note: `Event ${index + 1}`
    }))
  });
  await prisma.communication.createMany({
    data: Array.from({ length: 25 }, (_, index) => ({
      caseId,
      direction: "INBOUND" as const,
      channel: "EMAIL" as const,
      status: "RECEIVED" as const,
      subject: `Message ${index + 1}`
    }))
  });
});

afterAll(async () => {
  await prisma.organization.delete({ where: { id: organizationId } });
  await prisma.$disconnect();
});

describe("dashboard case loading", () => {
  it("keeps the list lightweight and loads complete selected history", async () => {
    const summaries = await getDashboardCases(organizationId);
    expect(summaries).toHaveLength(1);
    expect(summaries[0]).toMatchObject({
      detailsLoaded: false,
      eventCount: 35,
      communicationCount: 25,
      events: [],
      communications: []
    });

    const detail = await getDashboardCaseById(caseId, organizationId);
    expect(detail).toMatchObject({
      detailsLoaded: true,
      eventCount: 35,
      communicationCount: 25
    });
    expect(detail?.events).toHaveLength(35);
    expect(detail?.communications).toHaveLength(25);
  });
});
