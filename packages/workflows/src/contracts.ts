import type { CaseStatus } from "@fakturio/shared";

export const CASE_TASK_QUEUE = "fakturio-collection";
export const CASE_ACTIVITY_START_TO_CLOSE_TIMEOUT_MS = 2 * 60 * 1000;
export const PAYMENT_CHECK_SEND_LEASE_GRACE_MS = 30 * 1000;
export const PAYMENT_CHECK_SEND_LEASE_MS =
  CASE_ACTIVITY_START_TO_CLOSE_TIMEOUT_MS + PAYMENT_CHECK_SEND_LEASE_GRACE_MS;

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
};

export interface CaseWorkflowActivities {
  loadCaseSnapshot(input: { caseId: string; organizationId: string }): Promise<CaseSnapshot>;
  recordWorkflowEvent(input: { caseId: string; organizationId: string; type: string; note?: string }): Promise<void>;
  sendPaymentCheckEmail(input: { caseId: string; organizationId: string }): Promise<void>;
  sendReminderEmail(input: {
    caseId: string;
    organizationId: string;
    reminderLevel: 1 | 2 | "payment-request" | "final";
  }): Promise<void>;
  markCaseOverdue(input: { caseId: string; organizationId: string }): Promise<void>;
}
