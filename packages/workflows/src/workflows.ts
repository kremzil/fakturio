import { proxyActivities, sleep } from "@temporalio/workflow";
import type { CaseWorkflowActivities, CaseWorkflowInput } from "./contracts";
import { STANDARD_REMINDER_SCHEDULE, daysAfter } from "./schedules";

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

  const now = Date.now();
  const firstReminderAt = daysAfter(snapshot.dueDate, STANDARD_REMINDER_SCHEDULE.firstReminderDaysAfterDue);
  if (firstReminderAt.getTime() > now) {
    await sleep(firstReminderAt.getTime() - now);
  }

  await activities.markCaseOverdue({ caseId: input.caseId });
  await activities.sendReminderEmail({ caseId: input.caseId, reminderLevel: 1 });

  await activities.recordWorkflowEvent({
    caseId: input.caseId,
    type: "WORKFLOW_WAITING",
    note: "Bootstrap workflow sent first reminder. Later stages add the full escalation schedule."
  });
}
