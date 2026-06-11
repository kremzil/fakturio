import type { CaseStatus } from "./case-status";

export const WORKFLOW_COMMAND_TYPES = {
  caseStateChanged: "CASE_STATE_CHANGED",
  debtorReplyReceived: "DEBTOR_REPLY_RECEIVED",
  paymentCheckResolved: "PAYMENT_CHECK_RESOLVED"
} as const;

export type CaseWorkflowCommand =
  | {
      commandId: string;
      type: typeof WORKFLOW_COMMAND_TYPES.caseStateChanged;
      payload: { status: CaseStatus };
    }
  | {
      commandId: string;
      type: typeof WORKFLOW_COMMAND_TYPES.debtorReplyReceived;
      payload: { communicationId: string };
    }
  | {
      commandId: string;
      type: typeof WORKFLOW_COMMAND_TYPES.paymentCheckResolved;
      payload: { paymentCheckId: string };
    };
