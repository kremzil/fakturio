import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Worker } from "@temporalio/worker";
import { TestWorkflowEnvironment } from "@temporalio/testing";
import type { CaseStatus } from "@fakturio/shared";
import type { CaseSnapshot, CaseWorkflowActivities } from "./contracts";
import { caseStateChangedSignal } from "./signals";
import { daysAfter, STANDARD_REMINDER_SCHEDULE, startOfInvoiceDay } from "./schedules";

describe("workflow schedules", () => {
  it("computes reminder dates after due date", () => {
    expect(daysAfter("2026-06-02", STANDARD_REMINDER_SCHEDULE.firstReminderDaysAfterDue).toISOString()).toBe(
      "2026-06-03T00:00:00.000Z"
    );
  });

  it("computes the payment check date from the invoice due date", () => {
    expect(startOfInvoiceDay("2026-06-02").toISOString()).toBe("2026-06-02T00:00:00.000Z");
  });
});

describe("caseWorkflow durability", () => {
  let testEnv: TestWorkflowEnvironment;

  beforeAll(async () => {
    testEnv = await TestWorkflowEnvironment.createTimeSkipping();
  }, 60_000);

  afterAll(async () => {
    await testEnv?.teardown();
  });

  it.each([
    ["CLOSED_PAID", "WORKFLOW_COMPLETED"],
    ["OVERDUE", "WORKFLOW_OVERDUE"]
  ] as const)("waits until due date and reacts to %s signal", async (nextStatus, expectedEvent) => {
    const now = await testEnv.currentTimeMs();
    const dueDate = new Date(now + 3 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    let status: CaseStatus = "WAITING_FOR_DUE_DATE";
    const sentPaymentChecks: string[] = [];
    const events: string[] = [];

    const activities = createActivities({
      snapshot: () => snapshot(status, dueDate),
      onPaymentCheck: () => sentPaymentChecks.push("sent"),
      onEvent: (type) => events.push(type)
    });
    const taskQueue = `case-workflow-${randomUUID()}`;
    const worker = await Worker.create({
      connection: testEnv.nativeConnection,
      taskQueue,
      workflowsPath: fileURLToPath(new URL("./workflows.ts", import.meta.url)),
      activities
    });

    await worker.runUntil(async () => {
      const handle = await testEnv.client.workflow.start("caseWorkflow", {
        workflowId: `case-${randomUUID()}`,
        taskQueue,
        args: [{ caseId: "case-1", organizationId: "org-1" }]
      });

      await testEnv.sleep("4 days");
      expect(sentPaymentChecks).toEqual(["sent"]);

      status = nextStatus;
      await handle.signal(caseStateChangedSignal, {
        commandId: `command-${nextStatus}`,
        status: nextStatus
      });
      await handle.result();
    });

    expect(events).toContain(expectedEvent);
  }, 60_000);

  it("fails on an organization mismatch before recording any workflow event", async () => {
    const recordWorkflowEvent = vi.fn();
    const activities: CaseWorkflowActivities = {
      loadCaseSnapshot: vi.fn().mockRejectedValue(new Error("case belongs to another organization")),
      recordWorkflowEvent,
      sendPaymentCheckEmail: vi.fn(),
      sendReminderEmail: vi.fn(),
      markCaseOverdue: vi.fn()
    };
    const taskQueue = `case-workflow-${randomUUID()}`;
    const worker = await Worker.create({
      connection: testEnv.nativeConnection,
      taskQueue,
      workflowsPath: fileURLToPath(new URL("./workflows.ts", import.meta.url)),
      activities
    });

    await expect(
      worker.runUntil(() =>
        testEnv.client.workflow.execute("caseWorkflow", {
          workflowId: `case-${randomUUID()}`,
          taskQueue,
          args: [{ caseId: "case-1", organizationId: "wrong-org" }]
        })
      )
    ).rejects.toThrow();

    expect(recordWorkflowEvent).not.toHaveBeenCalled();
  }, 60_000);
});

function snapshot(status: CaseStatus, dueDate: string): CaseSnapshot {
  return {
    id: "case-1",
    status,
    dueDate,
    invoiceNumber: "FV-1",
    amountTotal: 100,
    currency: "EUR",
    debtorName: "Debtor",
    debtorEmail: "debtor@example.com",
    customerEmail: "owner@example.com",
    organizationName: "Org"
  };
}

function createActivities(input: {
  snapshot: () => CaseSnapshot;
  onPaymentCheck: () => void;
  onEvent: (type: string) => void;
}): CaseWorkflowActivities {
  return {
    async loadCaseSnapshot() {
      return input.snapshot();
    },
    async recordWorkflowEvent(event) {
      input.onEvent(event.type);
    },
    async sendPaymentCheckEmail() {
      input.onPaymentCheck();
    },
    async sendReminderEmail() {},
    async markCaseOverdue() {}
  };
}
