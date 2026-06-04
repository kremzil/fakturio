import { proxyActivities, sleep } from "@temporalio/workflow";
import {
  CASE_ACTIVITY_START_TO_CLOSE_TIMEOUT_MS,
  type CaseWorkflowActivities,
  type CaseWorkflowInput
} from "./contracts";
import { startOfInvoiceDay } from "./schedules";

const activities = proxyActivities<CaseWorkflowActivities>({
  startToCloseTimeout: CASE_ACTIVITY_START_TO_CLOSE_TIMEOUT_MS,
  retry: {
    initialInterval: "10 seconds",
    maximumAttempts: 5
  }
});

export async function caseWorkflow(input: CaseWorkflowInput): Promise<void> {
  // Verify the case actually belongs to the organization this workflow was started for BEFORE
  // writing any event. loadCaseSnapshot asserts the org boundary in its activity, so a
  // misrouted workflow fails here instead of mutating another organization's case.
  const snapshot = await activities.loadCaseSnapshot({ caseId: input.caseId, organizationId: input.organizationId });

  await activities.recordWorkflowEvent({
    caseId: input.caseId,
    organizationId: input.organizationId,
    type: "WORKFLOW_STARTED",
    note: "Collection workflow started."
  });

  if (!snapshot.dueDate || snapshot.status === "MANUAL_REVIEW_REQUIRED") {
    await activities.recordWorkflowEvent({
      caseId: input.caseId,
      organizationId: input.organizationId,
      type: "WORKFLOW_WAITING",
      note: "Case needs confirmed due date before automated collection can continue."
    });
    return;
  }

  if (snapshot.status !== "WAITING_FOR_DUE_DATE") {
    await activities.recordWorkflowEvent({
      caseId: input.caseId,
      organizationId: input.organizationId,
      type: "WORKFLOW_WAITING",
      note: `Workflow stopped because case status is ${snapshot.status}.`
    });
    return;
  }

  const dueAt = startOfInvoiceDay(snapshot.dueDate);
  if (dueAt.getTime() > Date.now()) {
    await sleep(dueAt.getTime() - Date.now());
  }

  const afterWait = await activities.loadCaseSnapshot({ caseId: input.caseId, organizationId: input.organizationId });
  if (afterWait.status !== "WAITING_FOR_DUE_DATE") {
    await activities.recordWorkflowEvent({
      caseId: input.caseId,
      organizationId: input.organizationId,
      type: "WORKFLOW_WAITING",
      note: `Payment check skipped because case status is ${afterWait.status}.`
    });
    return;
  }

  await activities.sendPaymentCheckEmail({ caseId: input.caseId, organizationId: input.organizationId });

  await activities.recordWorkflowEvent({
    caseId: input.caseId,
    organizationId: input.organizationId,
    type: "WORKFLOW_WAITING",
    note: "Payment check email sent to customer. Waiting for paid or not-paid confirmation."
  });
}
