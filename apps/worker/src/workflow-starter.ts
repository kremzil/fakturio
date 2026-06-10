import {
  WorkflowIdConflictPolicy,
  WorkflowIdReusePolicy,
  type Client
} from "@temporalio/client";
import { prisma } from "@fakturio/db";
import { CASE_EVENT_TYPES } from "@fakturio/shared";
import { CASE_TASK_QUEUE } from "@fakturio/workflows";

export async function startPendingCaseWorkflows(input: {
  client: Client;
  taskQueue: string;
}): Promise<void> {
  const cases = await prisma.case.findMany({
    where: {
      status: "WAITING_FOR_DUE_DATE",
      workflowId: null,
      dueDate: { not: null }
    },
    select: {
      id: true,
      organizationId: true
    },
    take: 25,
    orderBy: { confirmedAt: "asc" }
  });

  for (const collectionCase of cases) {
    const workflowId = `case-${collectionCase.id}`;
    try {
      await input.client.workflow.start("caseWorkflow", {
        taskQueue: input.taskQueue || CASE_TASK_QUEUE,
        workflowId,
        args: [{ caseId: collectionCase.id, organizationId: collectionCase.organizationId }],
        workflowIdReusePolicy: WorkflowIdReusePolicy.REJECT_DUPLICATE,
        workflowIdConflictPolicy: WorkflowIdConflictPolicy.USE_EXISTING
      });
      await prisma.case.update({
        where: { id: collectionCase.id },
        data: {
          workflowId,
          events: {
            create: {
              actorType: "WORKFLOW",
              type: CASE_EVENT_TYPES.workflowStarted,
              note: `Temporal workflow ${workflowId} started.`
            }
          }
        }
      });
    } catch (error) {
      if (error instanceof Error && error.name === "WorkflowExecutionAlreadyStartedError") {
        await prisma.case.update({
          where: { id: collectionCase.id },
          data: { workflowId }
        });
        continue;
      }

      await prisma.caseEvent.create({
        data: {
          caseId: collectionCase.id,
          actorType: "WORKFLOW",
          type: CASE_EVENT_TYPES.workflowWaiting,
          note: error instanceof Error ? `Temporal workflow start failed: ${error.message}` : "Temporal workflow start failed."
        }
      });
    }
  }
}
