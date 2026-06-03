import { proxyActivities, sleep } from "@temporalio/workflow";
import type { CaseWorkflowActivities, CaseWorkflowInput } from "./contracts";
import { startOfInvoiceDay } from "./schedules";

const activities = proxyActivities<CaseWorkflowActivities>({
  startToCloseTimeout: "2 minutes",
  retry: {
    initialInterval: "10 seconds",
    maximumAttempts: 5
  }
});

export async function caseWorkflow(input: CaseWorkflowInput): Promise<void> {
  await activities.recordWorkflowEvent({
    caseId: input.caseId,
    type: "WORKFLOW_STARTED",
    note: "Collection workflow started."
  });

  const snapshot = await activities.loadCaseSnapshot({ caseId: input.caseId });
  if (!snapshot.dueDate || snapshot.status === "MANUAL_REVIEW_REQUIRED") {
    await activities.recordWorkflowEvent({
      caseId: input.caseId,
      type: "WORKFLOW_WAITING",
      note: "Case needs confirmed due date before automated collection can continue."
    });
    return;
  }

  if (snapshot.status !== "WAITING_FOR_DUE_DATE") {
    await activities.recordWorkflowEvent({
      caseId: input.caseId,
      type: "WORKFLOW_WAITING",
      note: `Workflow stopped because case status is ${snapshot.status}.`
    });
    return;
  }

  const dueAt = startOfInvoiceDay(snapshot.dueDate);
  if (dueAt.getTime() > Date.now()) {
    await sleep(dueAt.getTime() - Date.now());
  }

  const afterWait = await activities.loadCaseSnapshot({ caseId: input.caseId });
  if (afterWait.status !== "WAITING_FOR_DUE_DATE") {
    await activities.recordWorkflowEvent({
      caseId: input.caseId,
      type: "WORKFLOW_WAITING",
      note: `Payment check skipped because case status is ${afterWait.status}.`
    });
    return;
  }

  await activities.sendPaymentCheckEmail({ caseId: input.caseId });

  await activities.recordWorkflowEvent({
    caseId: input.caseId,
    type: "WORKFLOW_WAITING",
    note: "Payment check email sent to customer. Waiting for paid or not-paid confirmation."
  });
}
