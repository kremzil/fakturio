import type { CaseStatus } from "@fakturio/shared";

export const CASE_TASK_QUEUE = "fakturio-collection";

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
};

export interface CaseWorkflowActivities {
  loadCaseSnapshot(input: { caseId: string }): Promise<CaseSnapshot>;
  recordWorkflowEvent(input: { caseId: string; type: string; note?: string }): Promise<void>;
  sendReminderEmail(input: { caseId: string; reminderLevel: 1 | 2 | "payment-request" | "final" }): Promise<void>;
  markCaseOverdue(input: { caseId: string }): Promise<void>;
}
