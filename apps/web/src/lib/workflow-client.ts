import { CASE_EVENT_TYPES } from "@fakturio/shared";
import { prisma } from "@fakturio/db";

export async function requestCaseWorkflowStart(input: { caseId: string; organizationId: string }): Promise<void> {
  const workflowId = `case-${input.caseId}`;
  await prisma.caseEvent.create({
    data: {
      caseId: input.caseId,
      actorType: "SYSTEM",
      type: CASE_EVENT_TYPES.workflowWaiting,
      note: `Workflow start requested for ${workflowId}.`
    }
  });
}
