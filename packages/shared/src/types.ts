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
  generateDebtorEmail(input: GenerateEmailInput): Promise<GeneratedEmail>;
  summarizeCase(input: CaseSummaryInput): Promise<CaseSummary>;
}
