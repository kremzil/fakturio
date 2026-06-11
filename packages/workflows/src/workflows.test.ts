import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Worker } from "@temporalio/worker";
import { TestWorkflowEnvironment } from "@temporalio/testing";
import {
  WORKFLOW_COMMAND_TYPES,
  type CaseStatus
} from "@fakturio/shared";
import type {
  CaseSnapshot,
  CaseWorkflowActivities,
  PaymentCheckReason
} from "./contracts";
import {
  caseStateChangedSignal,
  legacyCaseStateChangedSignal
} from "./signals";

describe("caseWorkflow durability", () => {
  let testEnv: TestWorkflowEnvironment;

  beforeAll(async () => {
    testEnv = await TestWorkflowEnvironment.createTimeSkipping();
  }, 60_000);

  afterAll(async () => {
    await testEnv?.teardown();
  });

  it("keeps running after reminder 1 and sends the follow-up check on nextActionAt", async () => {
    const now = await testEnv.currentTimeMs();
    let state: CaseSnapshot = {
      ...snapshot("EMAIL_REMINDER_1_SENT", null),
      nextActionAt: new Date(now + 24 * 60 * 60 * 1000).toISOString()
    };
    const checks: PaymentCheckReason[] = [];
    const activities = createActivities({
      snapshot: () => state,
      onPaymentCheck: (reason) => {
        checks.push(reason);
        state = { ...state, nextActionAt: null };
      }
    });
    const { worker, taskQueue } = await createWorker(testEnv, activities);

    await worker.runUntil(async () => {
      const handle = await testEnv.client.workflow.start("caseWorkflow", {
        workflowId: `case-${randomUUID()}`,
        taskQueue,
        args: [{ caseId: "case-1", organizationId: "org-1" }]
      });
      await testEnv.sleep("2 days");
      expect(checks).toEqual(["FOLLOW_UP"]);
      await handle.cancel();
      await handle.result().catch(() => undefined);
    });
  }, 60_000);

  it("turns a debtor payment claim into an immediate customer check", async () => {
    const state = snapshot("EMAIL_REMINDER_1_SENT", null);
    const checks: PaymentCheckReason[] = [];
    const activities = createActivities({
      snapshot: () => state,
      onPaymentCheck: (reason) => checks.push(reason),
      replyResult: {
        kind: "CHECK_PAYMENT_NOW",
        communicationId: "comm-1"
      }
    });
    const { worker, taskQueue } = await createWorker(testEnv, activities);

    await worker.runUntil(async () => {
      const handle = await testEnv.client.workflow.start("caseWorkflow", {
        workflowId: `case-${randomUUID()}`,
        taskQueue,
        args: [{ caseId: "case-1", organizationId: "org-1" }]
      });
      await handle.signal(caseStateChangedSignal, {
        commandId: "reply-command",
        type: WORKFLOW_COMMAND_TYPES.debtorReplyReceived,
        payload: { communicationId: "comm-1" }
      });
      await testEnv.sleep("1 hour");
      expect(checks).toEqual(["DEBTOR_CLAIMED_PAID"]);
      await handle.cancel();
      await handle.result().catch(() => undefined);
    });
  }, 60_000);

  it("processes a debtor reply before the original due date", async () => {
    const now = await testEnv.currentTimeMs();
    let state: CaseSnapshot = {
      ...snapshot(
        "WAITING_FOR_DUE_DATE",
        new Date(now + 30 * 24 * 60 * 60 * 1000)
          .toISOString()
          .slice(0, 10)
      )
    };
    const replies: string[] = [];
    const checks: PaymentCheckReason[] = [];
    const activities = createActivities({
      snapshot: () => state,
      onReply: (communicationId) => {
        replies.push(communicationId);
        state = {
          ...state,
          automationPaused: true
        };
      },
      onPaymentCheck: (reason) => checks.push(reason),
      replyResult: {
        kind: "PAUSED",
        communicationId: "comm-dispute"
      }
    });
    const { worker, taskQueue } = await createWorker(testEnv, activities);

    await worker.runUntil(async () => {
      const handle = await testEnv.client.workflow.start("caseWorkflow", {
        workflowId: `case-${randomUUID()}`,
        taskQueue,
        args: [{ caseId: "case-1", organizationId: "org-1" }]
      });
      await handle.signal(caseStateChangedSignal, {
        commandId: "early-dispute",
        type: WORKFLOW_COMMAND_TYPES.debtorReplyReceived,
        payload: { communicationId: "comm-dispute" }
      });
      await testEnv.sleep("1 day");
      expect(replies).toEqual(["comm-dispute"]);
      expect(checks).toEqual([]);
      await handle.cancel();
      await handle.result().catch(() => undefined);
    });
  }, 60_000);

  it("does not hot-loop after a reminder is paused for missing email", async () => {
    let state = snapshot("OVERDUE", null);
    const reminders: number[] = [];
    const activities = createActivities({
      snapshot: () => state,
      onReminder: (level) => {
        reminders.push(level);
        state = { ...state, automationPaused: true };
      },
      reminderResult: "SKIPPED_MISSING_RECIPIENT"
    });
    const { worker, taskQueue } = await createWorker(testEnv, activities);

    await worker.runUntil(async () => {
      const handle = await testEnv.client.workflow.start("caseWorkflow", {
        workflowId: `case-${randomUUID()}`,
        taskQueue,
        args: [{ caseId: "case-1", organizationId: "org-1" }]
      });
      await testEnv.sleep("10 days");
      expect(reminders).toEqual([1]);
      await handle.cancel();
      await handle.result().catch(() => undefined);
    });
  }, 60_000);

  it("does not hot-loop when reminder 1 was already sent but status is still overdue", async () => {
    const state = snapshot("OVERDUE", null);
    const reminders: number[] = [];
    const activities = createActivities({
      snapshot: () => state,
      onReminder: (level) => reminders.push(level),
      reminderResult: "ALREADY_SENT"
    });
    const { worker, taskQueue } = await createWorker(testEnv, activities);

    await worker.runUntil(async () => {
      const handle = await testEnv.client.workflow.start("caseWorkflow", {
        workflowId: `case-${randomUUID()}`,
        taskQueue,
        args: [{ caseId: "case-1", organizationId: "org-1" }]
      });
      await testEnv.sleep("10 days");
      expect(reminders).toEqual([1]);
      await handle.cancel();
      await handle.result().catch(() => undefined);
    });
  }, 60_000);

  it("sends reminder 2 after a follow-up check is resolved not paid", async () => {
    let state = snapshot("EMAIL_REMINDER_1_SENT", null);
    const reminders: number[] = [];
    const activities = createActivities({
      snapshot: () => state,
      onReminder: (level) => {
        reminders.push(level);
        state = { ...state, status: "EMAIL_REMINDER_2_SENT" };
      },
      paymentResult: {
        id: "follow-up-check",
        reason: "FOLLOW_UP",
        action: "NOT_PAID",
        installmentPaymentId: null
      }
    });
    const { worker, taskQueue } = await createWorker(testEnv, activities);

    await worker.runUntil(async () => {
      const handle = await testEnv.client.workflow.start("caseWorkflow", {
        workflowId: `case-${randomUUID()}`,
        taskQueue,
        args: [{ caseId: "case-1", organizationId: "org-1" }]
      });
      await handle.signal(caseStateChangedSignal, {
        commandId: "follow-up-not-paid",
        type: WORKFLOW_COMMAND_TYPES.paymentCheckResolved,
        payload: { paymentCheckId: "follow-up-check" }
      });
      await testEnv.sleep("1 hour");
      expect(reminders).toEqual([2]);
      await handle.cancel();
      await handle.result().catch(() => undefined);
    });
  }, 60_000);

  it("waits for and advances through all three installment checks", async () => {
    const now = await testEnv.currentTimeMs();
    let state: CaseSnapshot = {
      ...snapshot("INSTALLMENT_ACTIVE", null),
      nextActionAt: new Date(now + 24 * 60 * 60 * 1000).toISOString(),
      nextInstallmentPaymentId: "installment-1"
    };
    const checks: PaymentCheckReason[] = [];
    const activities = createActivities({
      snapshot: () => state,
      onPaymentCheck: (reason) => {
        checks.push(reason);
        state = { ...state, nextActionAt: null };
      },
      paymentResult: {
        id: "installment-check",
        reason: "INSTALLMENT_PAYMENT",
        action: "PAID",
        installmentPaymentId: "installment-payment"
      }
    });
    const { worker, taskQueue } = await createWorker(testEnv, activities);

    await worker.runUntil(async () => {
      const handle = await testEnv.client.workflow.start("caseWorkflow", {
        workflowId: `case-${randomUUID()}`,
        taskQueue,
        args: [{ caseId: "case-1", organizationId: "org-1" }]
      });

      for (let sequence = 1; sequence <= 3; sequence += 1) {
        await testEnv.sleep("2 days");
        expect(checks).toHaveLength(sequence);
        expect(checks.at(-1)).toBe("INSTALLMENT_PAYMENT");

        state =
          sequence === 3
            ? { ...state, status: "CLOSED_PAID" }
            : {
                ...state,
                nextActionAt: new Date(
                  now + (sequence * 2 + 1) * 24 * 60 * 60 * 1000
                ).toISOString(),
                nextInstallmentPaymentId: `installment-${sequence + 1}`
              };
        await handle.signal(caseStateChangedSignal, {
          commandId: `installment-check-${sequence}`,
          type: WORKFLOW_COMMAND_TYPES.paymentCheckResolved,
          payload: { paymentCheckId: `check-${sequence}` }
        });
      }

      await handle.result();
    });
  }, 60_000);

  it("fails on organization mismatch before recording an event", async () => {
    const recordWorkflowEvent = vi.fn();
    const activities = createActivities({
      snapshot: () => {
        throw new Error("case belongs to another organization");
      },
      recordWorkflowEvent
    });
    const { worker, taskQueue } = await createWorker(testEnv, activities);

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

  it("replays a history produced by the pre-patch workflow", async () => {
    let state = snapshot("WAITING_FOR_DUE_DATE", "2026-01-01");
    const activities = createActivities({ snapshot: () => state });
    const taskQueue = `legacy-case-workflow-${randomUUID()}`;
    const worker = await Worker.create({
      connection: testEnv.nativeConnection,
      taskQueue,
      workflowsPath: fileURLToPath(
        new URL("./legacy-workflow.fixture.ts", import.meta.url)
      ),
      activities
    });
    const workflowId = `legacy-case-${randomUUID()}`;
    let history: unknown;

    await worker.runUntil(async () => {
      const handle = await testEnv.client.workflow.start("caseWorkflow", {
        workflowId,
        taskQueue,
        args: [{ caseId: "case-1", organizationId: "org-1" }]
      });
      await testEnv.sleep("1 hour");
      state = { ...state, status: "CLOSED_PAID" };
      await handle.signal(legacyCaseStateChangedSignal, {
        commandId: "legacy-paid",
        status: "CLOSED_PAID"
      });
      await handle.result();
      history = await handle.fetchHistory();
    });

    await Worker.runReplayHistory(
      {
        workflowsPath: fileURLToPath(
          new URL("./workflows.ts", import.meta.url)
        )
      },
      history!,
      workflowId
    );
  }, 60_000);
});

function snapshot(
  status: CaseStatus,
  dueDate: string | null
): CaseSnapshot {
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
    organizationName: "Org",
    nextActionAt: null,
    automationPaused: false,
    nextInstallmentPaymentId: null
  };
}

function createActivities(input: {
  snapshot: () => CaseSnapshot;
  onPaymentCheck?: (reason: PaymentCheckReason) => void;
  onReminder?: (level: number) => void;
  onReply?: (communicationId: string) => void;
  reminderResult?: Awaited<
    ReturnType<CaseWorkflowActivities["sendReminderEmail"]>
  >;
  paymentResult?: Awaited<
    ReturnType<CaseWorkflowActivities["loadPaymentCheckResult"]>
  >;
  replyResult?: Awaited<
    ReturnType<CaseWorkflowActivities["processDebtorReply"]>
  >;
  recordWorkflowEvent?: (event: unknown) => void;
}): CaseWorkflowActivities {
  return {
    async loadCaseSnapshot() {
      return input.snapshot();
    },
    async recordWorkflowEvent(event) {
      input.recordWorkflowEvent?.(event);
    },
    async sendPaymentCheckEmail(check) {
      const reason = check.reason ?? "DUE_DATE";
      input.onPaymentCheck?.(reason);
      return { paymentCheckId: `check-${reason}` };
    },
    async sendReminderEmail(reminder) {
      input.onReminder?.(Number(reminder.reminderLevel));
      return input.reminderResult ?? "SENT";
    },
    async processDebtorReply(reply) {
      input.onReply?.(reply.communicationId);
      return (
        input.replyResult ?? {
          kind: "IGNORED",
          communicationId: "comm"
        }
      );
    },
    async loadPaymentCheckResult() {
      return (
        input.paymentResult ?? {
          id: "check",
          reason: "FOLLOW_UP",
          action: "PAID",
          installmentPaymentId: null
        }
      );
    },
    async sendInstallmentBrokenEmail() {},
    async markCaseOverdue() {}
  };
}

async function createWorker(
  testEnv: TestWorkflowEnvironment,
  activities: CaseWorkflowActivities
) {
  const taskQueue = `case-workflow-${randomUUID()}`;
  const worker = await Worker.create({
    connection: testEnv.nativeConnection,
    taskQueue,
    workflowsPath: fileURLToPath(new URL("./workflows.ts", import.meta.url)),
    activities
  });
  return { worker, taskQueue };
}
