import type {
  CaseStatus,
  PaymentCheckAction
} from "@fakturio/shared";

export const CASE_TASK_QUEUE = "fakturio-collection";
export const CASE_ACTIVITY_START_TO_CLOSE_TIMEOUT_MS = 2 * 60 * 1000;
export const PAYMENT_CHECK_SEND_LEASE_GRACE_MS = 30 * 1000;
export const PAYMENT_CHECK_SEND_LEASE_MS =
  CASE_ACTIVITY_START_TO_CLOSE_TIMEOUT_MS + PAYMENT_CHECK_SEND_LEASE_GRACE_MS;
export const FIRST_REMINDER_PAYMENT_TERM_DAYS = 10;

export type CaseWorkflowInput = {
  caseId: string;
  organizationId: string;
};

export type CaseSnapshot = {
  id: string;
  status: CaseStatus;
  dueDate: string | null;
  invoiceNumber: string | null;
  amountTotal: number | null;
  currency: string | null;
  debtorName: string | null;
  debtorEmail: string | null;
  customerEmail: string | null;
  organizationName: string | null;
  nextActionAt: string | null;
  automationPaused: boolean;
  nextInstallmentPaymentId: string | null;
};

export type PaymentCheckReason =
  | "DUE_DATE"
  | "FOLLOW_UP"
  | "DEBTOR_CLAIMED_PAID"
  | "PROMISE_DUE"
  | "INSTALLMENT_PAYMENT";

export type PaymentCheckResult = {
  id: string;
  reason: PaymentCheckReason;
  action: PaymentCheckAction;
  installmentPaymentId: string | null;
};

export type DebtorReplyActionResult = {
  kind:
    | "IGNORED"
    | "CHECK_PAYMENT_NOW"
    | "DEADLINE_UNCHANGED"
    | "PROMISE_ACCEPTED"
    | "INSTALLMENT_PROPOSED"
    | "INSTALLMENT_ACTIVATED"
    | "INSTALLMENT_REJECTED"
    | "PAUSED"
    | "CLARIFICATION_REQUESTED"
    | "INVOICE_COPY_SENT"
    | "INVOICE_COPY_UNAVAILABLE";
  communicationId: string;
};

export interface CaseWorkflowActivities {
  loadCaseSnapshot(input: { caseId: string; organizationId: string }): Promise<CaseSnapshot>;
  recordWorkflowEvent(input: { caseId: string; organizationId: string; type: string; note?: string }): Promise<void>;
  sendPaymentCheckEmail(input: {
    caseId: string;
    organizationId: string;
    sourceKey?: string;
    reason?: PaymentCheckReason;
    installmentPaymentId?: string | null;
  }): Promise<{ paymentCheckId: string } | null>;
  sendReminderEmail(input: {
    caseId: string;
    organizationId: string;
    reminderLevel: 1 | 2 | "payment-request" | "final";
  }): Promise<"SENT" | "ALREADY_SENT" | "SKIPPED_MISSING_RECIPIENT" | "SKIPPED_CASE_STATE">;
  processDebtorReply(input: {
    caseId: string;
    organizationId: string;
    communicationId: string;
  }): Promise<DebtorReplyActionResult>;
  loadPaymentCheckResult(input: {
    caseId: string;
    organizationId: string;
    paymentCheckId: string;
  }): Promise<PaymentCheckResult>;
  sendInstallmentBrokenEmail(input: {
    caseId: string;
    organizationId: string;
    paymentCheckId: string;
  }): Promise<void>;
  markCaseOverdue(input: { caseId: string; organizationId: string }): Promise<void>;
}
