import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@fakturio/db";
import { updateDebtorEmailForOrg } from "./case-contact";

const runId = `case-contact-${Date.now().toString(36)}`;
const organizationId = `${runId}-org`;
const userId = `${runId}-user`;
const debtorId = `${runId}-debtor`;
const caseId = `${runId}-case`;

beforeAll(async () => {
  await prisma.user.create({
    data: { id: userId, email: `${runId}@example.com` }
  });
  await prisma.organization.create({
    data: { id: organizationId, name: "Contact Org", slug: organizationId }
  });
  await prisma.membership.create({
    data: { userId, organizationId, role: "OWNER" }
  });
  await prisma.debtor.create({
    data: { id: debtorId, organizationId, name: "Debtor" }
  });
  await prisma.case.create({
    data: {
      id: caseId,
      organizationId,
      debtorId,
      status: "OVERDUE",
      confirmedAt: new Date(),
      automationPausedAt: new Date(),
      automationPauseReason: "MISSING_DEBTOR_EMAIL",
      debtorSnapshot: { name: "Debtor" }
    }
  });
});

afterAll(async () => {
  await prisma.organization.delete({ where: { id: organizationId } });
  await prisma.user.delete({ where: { id: userId } });
  await prisma.$disconnect();
});

describe("active case debtor contact", () => {
  it("updates the email without resuming automation", async () => {
    const result = await updateDebtorEmailForOrg({
      caseId,
      organizationId,
      userId,
      email: "debtor@example.com"
    });

    expect(result?.debtorEmail).toBe("debtor@example.com");
    expect(result?.automationPausedAt).not.toBeNull();
    expect(result?.automationPauseReason).toBe("MISSING_DEBTOR_EMAIL");
    expect(
      await prisma.caseEvent.count({
        where: { caseId, type: "CONTACT_UPDATED", actorId: userId }
      })
    ).toBe(1);
  });
});
