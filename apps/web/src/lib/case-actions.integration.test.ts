import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@fakturio/db";
import {
  CaseActionConflictError,
  applyManualCaseAction
} from "./case-actions";

const runId = `dashboard-${Date.now().toString(36)}`;
const organizationId = `${runId}-org`;
const otherOrganizationId = `${runId}-other-org`;
const userId = `${runId}-user`;
const caseId = `${runId}-case`;
const otherCaseId = `${runId}-other-case`;
const draftCaseId = `${runId}-draft-case`;

beforeAll(async () => {
  await prisma.user.create({
    data: { id: userId, email: `${runId}@example.com`, name: "Dashboard User" }
  });
  await prisma.organization.createMany({
    data: [
      { id: organizationId, name: "Dashboard Org", slug: organizationId },
      {
        id: otherOrganizationId,
        name: "Other Dashboard Org",
        slug: otherOrganizationId
      }
    ]
  });
  await prisma.membership.create({
    data: { userId, organizationId, role: "OWNER" }
  });
  await prisma.case.createMany({
    data: [
      {
        id: caseId,
        organizationId,
        status: "OVERDUE",
        confirmedAt: new Date(),
        invoiceNumber: "DASH-1",
        amountTotal: 100,
        currency: "EUR"
      },
      {
        id: otherCaseId,
        organizationId: otherOrganizationId,
        status: "OVERDUE",
        confirmedAt: new Date(),
        invoiceNumber: "DASH-2",
        amountTotal: 200,
        currency: "EUR"
      },
      {
        id: draftCaseId,
        organizationId,
        status: "PARSED",
        invoiceNumber: "DASH-DRAFT",
        amountTotal: 50,
        currency: "EUR"
      }
    ]
  });
});

afterAll(async () => {
  await prisma.organization.deleteMany({
    where: { id: { in: [organizationId, otherOrganizationId] } }
  });
  await prisma.user.deleteMany({ where: { id: userId } });
  await prisma.$disconnect();
});

describe("manual dashboard case actions", () => {
  it("pauses, resumes and cancels with audit commands", async () => {
    const paused = await applyManualCaseAction({
      caseId,
      organizationId,
      userId,
      action: "PAUSE_AUTOMATION"
    });
    expect(paused?.automationPausedAt).not.toBeNull();
    expect(paused?.automationPauseReason).toBe("MANUAL_PAUSE");

    const resumed = await applyManualCaseAction({
      caseId,
      organizationId,
      userId,
      action: "RESUME_AUTOMATION"
    });
    expect(resumed?.automationPausedAt).toBeNull();

    const cancelled = await applyManualCaseAction({
      caseId,
      organizationId,
      userId,
      action: "CANCEL_CASE"
    });
    expect(cancelled?.status).toBe("CLOSED_CANCELLED");
    expect(cancelled?.closedAt).not.toBeNull();

    expect(
      await prisma.workflowCommand.count({ where: { caseId } })
    ).toBe(3);
    expect(
      await prisma.caseEvent.count({
        where: {
          caseId,
          actorType: "USER",
          type: { in: ["AUTOMATION_PAUSED", "STATUS_CHANGED"] }
        }
      })
    ).toBe(3);
  });

  it("does not expose another organization's case", async () => {
    const result = await applyManualCaseAction({
      caseId: otherCaseId,
      organizationId,
      userId,
      action: "PAUSE_AUTOMATION"
    });
    expect(result).toBeNull();
  });

  it("rejects workflow actions before confirmation", async () => {
    await expect(
      applyManualCaseAction({
        caseId: draftCaseId,
        organizationId,
        userId,
        action: "PAUSE_AUTOMATION"
      })
    ).rejects.toBeInstanceOf(CaseActionConflictError);

    expect(
      await prisma.workflowCommand.count({ where: { caseId: draftCaseId } })
    ).toBe(0);
  });

  it("cancels an unconfirmed draft without starting Temporal", async () => {
    const cancelled = await applyManualCaseAction({
      caseId: draftCaseId,
      organizationId,
      userId,
      action: "CANCEL_CASE"
    });

    expect(cancelled?.status).toBe("CLOSED_CANCELLED");
    expect(
      await prisma.workflowCommand.count({ where: { caseId: draftCaseId } })
    ).toBe(0);
  });
});
