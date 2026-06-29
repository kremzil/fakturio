import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  WorkflowIdConflictPolicy,
  WorkflowIdReusePolicy
} from "@temporalio/client";

const findMany = vi.fn();
const updateManyAndReturn = vi.fn();
const workflowCommandUpdateMany = vi.fn();
const caseUpdateMany = vi.fn();
const transaction = vi.fn();
const signalWithStart = vi.fn();
const signal = vi.fn();

vi.mock("@fakturio/db", () => ({
  prisma: {
    workflowCommand: {
      findMany,
      updateManyAndReturn,
      updateMany: workflowCommandUpdateMany
    },
    case: {
      updateMany: caseUpdateMany
    },
    $transaction: transaction
  }
}));

const { dispatchPendingWorkflowCommands } = await import("./workflow-command-dispatcher");

const client = {
  workflow: {
    signalWithStart
  }
};

beforeEach(() => {
  findMany.mockReset();
  updateManyAndReturn.mockReset();
  workflowCommandUpdateMany.mockReset();
  caseUpdateMany.mockReset();
  transaction.mockReset();
  signalWithStart.mockReset();
  signal.mockReset();

  findMany.mockResolvedValue([]);
  workflowCommandUpdateMany.mockResolvedValue({ count: 1 });
  caseUpdateMany.mockResolvedValue({ count: 1 });
  transaction.mockResolvedValue([{ count: 1 }, { count: 1 }]);
});

describe("workflow command dispatcher", () => {
  it("claims and delivers a case-state command with signalWithStart", async () => {
    const command = {
      id: "cmd-1",
      caseId: "case-1",
      organizationId: "org-1",
      type: "CASE_STATE_CHANGED",
      payload: { status: "CLOSED_PAID" },
      attempts: 0
    };
    findMany.mockResolvedValue([command]);
    updateManyAndReturn.mockResolvedValue([{ ...command, leaseId: "lease" }]);
    signalWithStart.mockResolvedValue({
      workflowId: "case-case-1",
      signal
    });

    await dispatchPendingWorkflowCommands(client as never, "test-queue");

    expect(signalWithStart).toHaveBeenCalledWith(
      "caseWorkflow",
      expect.objectContaining({
        workflowId: "case-case-1",
        taskQueue: "test-queue",
        workflowIdReusePolicy: WorkflowIdReusePolicy.ALLOW_DUPLICATE_FAILED_ONLY,
        workflowIdConflictPolicy: WorkflowIdConflictPolicy.USE_EXISTING,
        signalArgs: [
          {
            commandId: "cmd-1",
            type: "CASE_STATE_CHANGED",
            payload: { status: "CLOSED_PAID" }
          }
        ]
      })
    );
    expect(signal).toHaveBeenCalledWith(
      expect.objectContaining({ name: "caseStateChanged" }),
      { commandId: "cmd-1", status: "CLOSED_PAID" }
    );
    expect(transaction).toHaveBeenCalledTimes(1);
    expect(workflowCommandUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: "cmd-1", deliveredAt: null }),
        data: expect.objectContaining({ deliveredAt: expect.any(Date) })
      })
    );
  });

  it("does not deliver when another worker wins the lease", async () => {
    findMany.mockResolvedValue([
      {
        id: "cmd-1",
        caseId: "case-1",
        organizationId: "org-1",
        type: "CASE_STATE_CHANGED",
        payload: { status: "OVERDUE" },
        attempts: 0
      }
    ]);
    updateManyAndReturn.mockResolvedValue([]);

    await dispatchPendingWorkflowCommands(client as never, "test-queue");

    expect(signalWithStart).not.toHaveBeenCalled();
    expect(transaction).not.toHaveBeenCalled();
  });

  it("does not send a legacy signal for new command types", async () => {
    const command = {
      id: "cmd-reply",
      caseId: "case-1",
      organizationId: "org-1",
      type: "DEBTOR_REPLY_RECEIVED",
      payload: { communicationId: "comm-1" },
      attempts: 0
    };
    findMany.mockResolvedValue([command]);
    updateManyAndReturn.mockResolvedValue([{ ...command, leaseId: "lease" }]);
    signalWithStart.mockResolvedValue({
      workflowId: "case-case-1",
      signal
    });

    await dispatchPendingWorkflowCommands(client as never, "test-queue");

    expect(signalWithStart).toHaveBeenCalledTimes(1);
    expect(signal).not.toHaveBeenCalled();
  });

  it("releases the lease with backoff when Temporal delivery fails", async () => {
    const command = {
      id: "cmd-1",
      caseId: "case-1",
      organizationId: "org-1",
      type: "CASE_STATE_CHANGED",
      payload: { status: "OVERDUE" },
      attempts: 2
    };
    findMany.mockResolvedValue([command]);
    updateManyAndReturn.mockResolvedValue([{ ...command, leaseId: "lease" }]);
    signalWithStart.mockRejectedValue(new Error("Temporal unavailable"));

    await dispatchPendingWorkflowCommands(client as never, "test-queue");

    expect(workflowCommandUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: "cmd-1", deliveredAt: null }),
        data: expect.objectContaining({
          leaseId: null,
          leaseUntil: null,
          lastError: "Temporal unavailable",
          availableAt: expect.any(Date)
        })
      })
    );
    expect(transaction).not.toHaveBeenCalled();
  });
});
