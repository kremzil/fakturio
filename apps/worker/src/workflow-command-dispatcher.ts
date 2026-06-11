import { randomUUID } from "node:crypto";
import {
  WorkflowIdConflictPolicy,
  WorkflowIdReusePolicy,
  type Client
} from "@temporalio/client";
import {
  CASE_STATUSES,
  WORKFLOW_COMMAND_TYPES,
  type CaseStatus,
  type CaseWorkflowCommand
} from "@fakturio/shared";
import { prisma } from "@fakturio/db";
import {
  caseCommandSignal,
  legacyCaseStateChangedSignal,
  type CaseWorkflowInput
} from "@fakturio/workflows";

const COMMAND_LEASE_MS = 60_000;
const MAX_BATCH_SIZE = 25;

export async function dispatchPendingWorkflowCommands(
  client: Client,
  taskQueue: string
): Promise<void> {
  const now = new Date();
  const candidates = await prisma.workflowCommand.findMany({
    where: {
      deliveredAt: null,
      availableAt: { lte: now },
      OR: [{ leaseUntil: null }, { leaseUntil: { lt: now } }]
    },
    orderBy: { createdAt: "asc" },
    take: MAX_BATCH_SIZE
  });

  for (const candidate of candidates) {
    const leaseId = randomUUID();
    const leaseUntil = new Date(Date.now() + COMMAND_LEASE_MS);
    const claimed = await prisma.workflowCommand.updateManyAndReturn({
      where: {
        id: candidate.id,
        deliveredAt: null,
        availableAt: { lte: now },
        OR: [{ leaseUntil: null }, { leaseUntil: { lt: now } }]
      },
      data: {
        leaseId,
        leaseUntil,
        attempts: { increment: 1 },
        lastError: null
      }
    });

    if (claimed.length !== 1) {
      continue;
    }

    try {
      const command = parseWorkflowCommand(
        candidate.id,
        candidate.type,
        candidate.payload
      );
      const workflowId = `case-${candidate.caseId}`;
      const workflowInput: CaseWorkflowInput = {
        caseId: candidate.caseId,
        organizationId: candidate.organizationId
      };

      const handle = await client.workflow.signalWithStart("caseWorkflow", {
        workflowId,
        taskQueue,
        args: [workflowInput],
        signal: caseCommandSignal,
        signalArgs: [command],
        workflowIdReusePolicy: WorkflowIdReusePolicy.REJECT_DUPLICATE,
        workflowIdConflictPolicy: WorkflowIdConflictPolicy.USE_EXISTING
      });
      if (command.type === WORKFLOW_COMMAND_TYPES.caseStateChanged) {
        await handle.signal(legacyCaseStateChangedSignal, {
          commandId: command.commandId,
          status: command.payload.status
        });
      }

      await prisma.$transaction([
        prisma.workflowCommand.updateMany({
          where: { id: candidate.id, leaseId, deliveredAt: null },
          data: {
            deliveredAt: new Date(),
            leaseId: null,
            leaseUntil: null,
            lastError: null
          }
        }),
        prisma.case.updateMany({
          where: {
            id: candidate.caseId,
            organizationId: candidate.organizationId
          },
          data: { workflowId }
        })
      ]);
    } catch (error) {
      await prisma.workflowCommand.updateMany({
        where: { id: candidate.id, leaseId, deliveredAt: null },
        data: {
          availableAt: new Date(Date.now() + retryDelayMs(candidate.attempts + 1)),
          leaseId: null,
          leaseUntil: null,
          lastError: error instanceof Error ? error.message.slice(0, 2000) : "Unknown workflow command delivery error."
        }
      });
    }
  }
}

function parseWorkflowCommand(
  commandId: string,
  type: string,
  payload: unknown
): CaseWorkflowCommand {
  const record =
    payload && typeof payload === "object"
      ? (payload as Record<string, unknown>)
      : {};

  if (type === WORKFLOW_COMMAND_TYPES.caseStateChanged) {
    const status = record.status;
    if (
      typeof status !== "string" ||
      !CASE_STATUSES.includes(status as CaseStatus)
    ) {
      throw new Error("Workflow command payload contains an invalid case status.");
    }
    return {
      commandId,
      type,
      payload: { status: status as CaseStatus }
    };
  }

  if (
    type === WORKFLOW_COMMAND_TYPES.debtorReplyReceived &&
    typeof record.communicationId === "string"
  ) {
    return {
      commandId,
      type,
      payload: { communicationId: record.communicationId }
    };
  }

  if (
    type === WORKFLOW_COMMAND_TYPES.paymentCheckResolved &&
    typeof record.paymentCheckId === "string"
  ) {
    return {
      commandId,
      type,
      payload: { paymentCheckId: record.paymentCheckId }
    };
  }

  throw new Error(`Unsupported or invalid workflow command ${type}.`);
}

function retryDelayMs(attempt: number): number {
  return Math.min(5 * 60_000, Math.max(5_000, 2 ** Math.min(attempt, 6) * 1000));
}
