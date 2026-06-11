import {
  condition,
  patched,
  proxyActivities,
  setHandler,
  sleep
} from "@temporalio/workflow";
import type {
  CaseStatus,
  CaseWorkflowCommand
} from "@fakturio/shared";
import {
  CASE_ACTIVITY_START_TO_CLOSE_TIMEOUT_MS,
  type CaseSnapshot,
  type CaseWorkflowActivities,
  type CaseWorkflowInput
} from "./contracts";
import { startOfInvoiceDay } from "./schedules";
import {
  caseCommandSignal,
  legacyCaseStateChangedSignal,
  type LegacyCaseStateChangedSignalPayload
} from "./signals";

const COLLECTION_LOOP_PATCH = "case-collection-loop-v1";
const OVERDUE_REMINDER_GUARD_PATCH = "overdue-reminder-loop-guard-v1";
const WORKFLOW_COMMAND_TYPES = {
  caseStateChanged: "CASE_STATE_CHANGED",
  debtorReplyReceived: "DEBTOR_REPLY_RECEIVED",
  paymentCheckResolved: "PAYMENT_CHECK_RESOLVED"
} as const;

const activities = proxyActivities<CaseWorkflowActivities>({
  startToCloseTimeout: CASE_ACTIVITY_START_TO_CLOSE_TIMEOUT_MS,
  retry: {
    initialInterval: "10 seconds",
    maximumAttempts: 5
  }
});

export async function caseWorkflow(input: CaseWorkflowInput): Promise<void> {
  if (!patched(COLLECTION_LOOP_PATCH)) {
    return legacyCaseWorkflow(input);
  }
  return collectionCaseWorkflow(input);
}

async function collectionCaseWorkflow(
  input: CaseWorkflowInput
): Promise<void> {
  const pendingCommands: CaseWorkflowCommand[] = [];
  const acceptedCommandIds = new Set<string>();
  const enqueue = (command: CaseWorkflowCommand) => {
    if (acceptedCommandIds.has(command.commandId)) {
      return;
    }
    acceptedCommandIds.add(command.commandId);
    pendingCommands.push(command);
  };

  setHandler(caseCommandSignal, enqueue);
  setHandler(legacyCaseStateChangedSignal, (command) => {
    enqueue({
      commandId: command.commandId,
      type: WORKFLOW_COMMAND_TYPES.caseStateChanged,
      payload: { status: command.status }
    });
  });

  let snapshot = await activities.loadCaseSnapshot(input);
  await activities.recordWorkflowEvent({
    ...input,
    type: "WORKFLOW_STARTED",
    note: "Collection workflow started."
  });

  let dueDateCheckHandled = snapshot.status !== "WAITING_FOR_DUE_DATE";

  for (;;) {
    snapshot = await activities.loadCaseSnapshot(input);
    if (isTerminal(snapshot.status)) {
      await activities.recordWorkflowEvent({
        ...input,
        type: "WORKFLOW_COMPLETED",
        note: `Collection workflow completed with status ${snapshot.status}.`
      });
      return;
    }

    const command = pendingCommands.shift();
    if (command) {
      const outcome = await handleCommand(input, command);
      if (outcome === "PAYMENT_CHECK_SENT") {
        dueDateCheckHandled = true;
      }
      continue;
    }

    if (
      !dueDateCheckHandled &&
      snapshot.status === "WAITING_FOR_DUE_DATE"
    ) {
      if (snapshot.automationPaused || !snapshot.dueDate) {
        await condition(() => pendingCommands.length > 0);
        continue;
      }

      const dueAt = startOfInvoiceDay(snapshot.dueDate);
      const timeout = Math.max(0, dueAt.getTime() - Date.now());
      const signaled = await condition(
        () => pendingCommands.length > 0,
        timeout
      );
      if (signaled) {
        continue;
      }

      snapshot = await activities.loadCaseSnapshot(input);
      if (
        snapshot.status === "WAITING_FOR_DUE_DATE" &&
        !snapshot.automationPaused
      ) {
        const sent = await activities.sendPaymentCheckEmail({
          ...input,
          sourceKey: `due-date:${input.caseId}:${snapshot.dueDate}`,
          reason: "DUE_DATE"
        });
        dueDateCheckHandled = true;
        await activities.recordWorkflowEvent({
          ...input,
          type: "WORKFLOW_WAITING",
          note: sent
            ? "Payment check email sent to customer. Waiting for confirmation."
            : "Payment check paused because no customer recipient is configured."
        });
      }
      continue;
    }

    if (snapshot.automationPaused) {
      await condition(() => pendingCommands.length > 0);
      continue;
    }

    if (snapshot.status === "OVERDUE") {
      await sendReminder(input, 1);
      if (patched(OVERDUE_REMINDER_GUARD_PATCH)) {
        snapshot = await activities.loadCaseSnapshot(input);
        if (snapshot.status === "OVERDUE" && !snapshot.automationPaused) {
          await condition(() => pendingCommands.length > 0);
        }
      }
      continue;
    }

    if (!snapshot.nextActionAt) {
      await condition(() => pendingCommands.length > 0);
      continue;
    }

    const timeout = Math.max(
      0,
      new Date(snapshot.nextActionAt).getTime() - Date.now()
    );
    const signaled = await condition(
      () => pendingCommands.length > 0,
      timeout
    );
    if (signaled) {
      continue;
    }

    snapshot = await activities.loadCaseSnapshot(input);
    await runScheduledAction(input, snapshot);
  }
}

async function handleCommand(
  input: CaseWorkflowInput,
  command: CaseWorkflowCommand
): Promise<"HANDLED" | "PAYMENT_CHECK_SENT"> {
  if (command.type === WORKFLOW_COMMAND_TYPES.debtorReplyReceived) {
    const result = await activities.processDebtorReply({
      ...input,
      communicationId: command.payload.communicationId
    });
    if (result.kind === "CHECK_PAYMENT_NOW") {
      await activities.sendPaymentCheckEmail({
        ...input,
        sourceKey: `debtor-paid:${result.communicationId}`,
        reason: "DEBTOR_CLAIMED_PAID"
      });
      return "PAYMENT_CHECK_SENT";
    }
    return "HANDLED";
  }

  if (command.type === WORKFLOW_COMMAND_TYPES.paymentCheckResolved) {
    const result = await activities.loadPaymentCheckResult({
      ...input,
      paymentCheckId: command.payload.paymentCheckId
    });
    if (result.action === "NOT_PAID") {
      if (result.reason === "DUE_DATE") {
        await sendReminder(input, 1);
      } else if (result.reason === "INSTALLMENT_PAYMENT") {
        await activities.sendInstallmentBrokenEmail({
          ...input,
          paymentCheckId: result.id
        });
      } else {
        await sendReminder(input, 2);
      }
    }
    return "HANDLED";
  }

  if (
    command.type === WORKFLOW_COMMAND_TYPES.caseStateChanged &&
    command.payload.status === "OVERDUE"
  ) {
    await sendReminder(input, 1);
  }
  return "HANDLED";
}

async function runScheduledAction(
  input: CaseWorkflowInput,
  snapshot: CaseSnapshot
): Promise<void> {
  if (snapshot.status === "INSTALLMENT_ACTIVE") {
    if (!snapshot.nextInstallmentPaymentId) {
      return;
    }
    await activities.sendPaymentCheckEmail({
      ...input,
      sourceKey: `installment-payment:${snapshot.nextInstallmentPaymentId}`,
      reason: "INSTALLMENT_PAYMENT",
      installmentPaymentId: snapshot.nextInstallmentPaymentId
    });
    return;
  }

  if (
    snapshot.status === "EMAIL_REMINDER_1_SENT" ||
    snapshot.status === "PAYMENT_PROMISED"
  ) {
    const reason =
      snapshot.status === "PAYMENT_PROMISED" ? "PROMISE_DUE" : "FOLLOW_UP";
    await activities.sendPaymentCheckEmail({
      ...input,
      sourceKey: `${reason.toLowerCase()}:${input.caseId}:${snapshot.nextActionAt}`,
      reason
    });
  }
}

async function sendReminder(
  input: CaseWorkflowInput,
  level: 1 | 2
): Promise<
  Awaited<ReturnType<CaseWorkflowActivities["sendReminderEmail"]>>
> {
  const result = await activities.sendReminderEmail({
    ...input,
    reminderLevel: level
  });
  await activities.recordWorkflowEvent({
    ...input,
    type: "WORKFLOW_WAITING",
    note:
      result === "SENT"
        ? `Debtor reminder ${level} sent.`
        : result === "ALREADY_SENT"
          ? `Debtor reminder ${level} was already sent.`
        : result === "SKIPPED_MISSING_RECIPIENT"
          ? `Debtor reminder ${level} paused because the debtor has no email.`
          : `Debtor reminder ${level} skipped because the case state changed.`
  });
  return result;
}

function isTerminal(status: CaseSnapshot["status"]): boolean {
  return (
    status === "CLOSED_PAID" ||
    status === "CLOSED_CANCELLED" ||
    status === "CLOSED_UNRESOLVED"
  );
}

async function legacyCaseWorkflow(input: CaseWorkflowInput): Promise<void> {
  const pendingStateChanges: LegacyCaseStateChangedSignalPayload[] = [];
  const acceptedCommandIds = new Set<string>();

  setHandler(legacyCaseStateChangedSignal, (command) => {
    if (acceptedCommandIds.has(command.commandId)) {
      return;
    }
    acceptedCommandIds.add(command.commandId);
    pendingStateChanges.push(command);
  });

  const snapshot = await activities.loadCaseSnapshot({
    caseId: input.caseId,
    organizationId: input.organizationId
  });

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

  const afterWait = await activities.loadCaseSnapshot({
    caseId: input.caseId,
    organizationId: input.organizationId
  });
  if (afterWait.status !== "WAITING_FOR_DUE_DATE") {
    await activities.recordWorkflowEvent({
      caseId: input.caseId,
      organizationId: input.organizationId,
      type: "WORKFLOW_WAITING",
      note: `Payment check skipped because case status is ${afterWait.status}.`
    });
    return;
  }

  await activities.sendPaymentCheckEmail({
    caseId: input.caseId,
    organizationId: input.organizationId
  });

  await activities.recordWorkflowEvent({
    caseId: input.caseId,
    organizationId: input.organizationId,
    type: "WORKFLOW_WAITING",
    note: "Payment check email sent to customer. Waiting for paid or not-paid confirmation."
  });

  for (;;) {
    await condition(() => pendingStateChanges.length > 0);
    const command = pendingStateChanges.shift();
    if (!command) {
      continue;
    }

    const current = await activities.loadCaseSnapshot({
      caseId: input.caseId,
      organizationId: input.organizationId
    });

    if (current.status === "CLOSED_PAID") {
      await activities.recordWorkflowEvent({
        caseId: input.caseId,
        organizationId: input.organizationId,
        type: "WORKFLOW_COMPLETED",
        note: "Collection workflow completed because payment was confirmed."
      });
      return;
    }

    if (current.status === "OVERDUE") {
      await activities.recordWorkflowEvent({
        caseId: input.caseId,
        organizationId: input.organizationId,
        type: "WORKFLOW_OVERDUE",
        note: "Payment was not received. Case entered overdue collection."
      });
      return;
    }

    if (
      current.status === "CLOSED_CANCELLED" ||
      current.status === "CLOSED_UNRESOLVED"
    ) {
      await activities.recordWorkflowEvent({
        caseId: input.caseId,
        organizationId: input.organizationId,
        type: "WORKFLOW_COMPLETED",
        note: `Collection workflow completed because case status is ${current.status}.`
      });
      return;
    }

    await activities.recordWorkflowEvent({
      caseId: input.caseId,
      organizationId: input.organizationId,
      type: "WORKFLOW_WAITING",
      note: `State-change command ${command.commandId} was acknowledged; current case status is ${current.status}.`
    });
  }
}
