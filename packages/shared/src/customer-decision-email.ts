import { z } from "zod";

export type CustomerDecisionEmailInput = {
  organizationId: string;
  caseId: string;
  invoiceNumber: string;
  debtorName: string | null;
  amountTotal: number | null;
  currency: string | null;
  dueDate: string | null;
  debtorMessage: string | null;
  decisionReason: string;
  classificationSummary: string | null;
  caseUrl: string;
  replyToAddress: string;
  allowedReplies: string[];
};

export const customerDecisionEmailDraftSchema = z.object({
  subject: z.string().trim().min(6).max(160),
  textBody: z.string().trim().min(80).max(4000),
  summaryForAudit: z.string().trim().min(10).max(600)
});

export type CustomerDecisionEmailDraft = z.infer<typeof customerDecisionEmailDraftSchema>;
