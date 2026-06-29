import type { CustomerMessageClassification } from "./customer-message";
import type { DebtorReplyClassification, InvoiceExtractionResult } from "./invoice";

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
  classifyDebtorReply(input: DebtorReplyInput): Promise<DebtorReplyClassification>;
  classifyCustomerMessage(input: CustomerMessageInput): Promise<CustomerMessageClassification>;
  generateDebtorEmail(input: GenerateEmailInput): Promise<GeneratedEmail>;
  summarizeCase(input: CaseSummaryInput): Promise<CaseSummary>;
}
