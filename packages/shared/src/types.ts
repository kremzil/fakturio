import type { CustomerMessageClassification } from "./customer-message";
import type {
  CustomerDecisionEmailDraft,
  CustomerDecisionEmailInput
} from "./customer-decision-email";
import type { DashboardCaseAssistantInput, DashboardCaseAssistantReply } from "./case-assistant";
import type { DebtorReplyClassification, InvoiceExtractionResult } from "./invoice";
import type {
  InvoiceEmailAttachmentRef,
  InvoiceEmailAttachmentTriageResult
} from "./invoice-attachment-triage";

export type InvoiceExtractionInput = {
  fileName: string;
  mimeType: string;
  bytes: Uint8Array;
  emailBody?: string | null;
};

export type DebtorReplyInput = {
  caseId: string;
  messageText: string;
  latestCaseSummary?: string | null;
};

export type CustomerMessageInput = {
  organizationId: string;
  messageText: string;
  subject?: string | null;
  latestCaseSummary?: string | null;
  candidateCases?: Array<{
    caseId: string;
    invoiceNumber: string | null;
    debtorName: string | null;
    amountTotal: number | null;
    currency: string | null;
    status: string;
  }>;
};

export type InvoiceEmailAttachmentTriageInput = {
  organizationId: string;
  subject?: string | null;
  messageText?: string | null;
  attachments: Array<
    InvoiceEmailAttachmentRef & {
      bytes: Uint8Array;
    }
  >;
};

export type GenerateEmailInput = {
  caseId: string;
  language: "sk" | "cs" | "en";
  tone: "soft" | "standard" | "strict";
  invoiceNumber: string;
  amountTotal: number;
  currency: string;
  dueDate: string;
  debtorName: string;
};

export type GeneratedEmail = {
  subject: string;
  htmlBody: string;
  textBody: string;
  warnings: string[];
};

export type CaseSummaryInput = {
  caseId: string;
  events: string[];
};

export type CaseSummary = {
  summary: string;
  riskLevel: "LOW" | "MEDIUM" | "HIGH";
  recommendedNextAction: string;
};

export interface AiProvider {
  extractInvoice(input: InvoiceExtractionInput): Promise<InvoiceExtractionResult & { rawResult: unknown }>;
  classifyInvoiceEmailAttachments(input: InvoiceEmailAttachmentTriageInput): Promise<InvoiceEmailAttachmentTriageResult>;
  classifyDebtorReply(input: DebtorReplyInput): Promise<DebtorReplyClassification>;
  classifyCustomerMessage(input: CustomerMessageInput): Promise<CustomerMessageClassification>;
  answerDashboardCaseMessage(input: DashboardCaseAssistantInput): Promise<DashboardCaseAssistantReply>;
  draftCustomerDecisionEmail(input: CustomerDecisionEmailInput): Promise<CustomerDecisionEmailDraft>;
  generateDebtorEmail(input: GenerateEmailInput): Promise<GeneratedEmail>;
  summarizeCase(input: CaseSummaryInput): Promise<CaseSummary>;
}
