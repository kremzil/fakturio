import { CASE_EVENT_TYPES } from "@fakturio/shared";
import { prisma } from "@fakturio/db";

export async function requestCaseWorkflowStart(input: { caseId: string; organizationId: string }): Promise<void> {
  // Enforce the organization boundary here too: never record a workflow-start event for a case
  // that does not belong to the requesting organization.
  const owned = await prisma.case.findFirst({
    where: { id: input.caseId, organizationId: input.organizationId },
    select: { id: true }
  });

  if (!owned) {
    throw new Error(`Case ${input.caseId} not found in organization ${input.organizationId}.`);
  }

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
