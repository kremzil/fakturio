import { z } from "zod";

const nullableText = z.string().nullable();

export const partySchema = z.object({
  name: nullableText,
  email: nullableText,
  ico: nullableText,
  dic: nullableText,
  icDph: nullableText,
  address: nullableText
});

export const paymentFieldsSchema = z.object({
  iban: nullableText,
  variableSymbol: nullableText,
  constantSymbol: nullableText,
  specificSymbol: nullableText
});

export const invoiceExtractionResultSchema = z.object({
  invoiceNumber: nullableText,
  issueDate: nullableText.describe("ISO date YYYY-MM-DD, or null if not visible"),
  dueDate: nullableText.describe("ISO date YYYY-MM-DD, or null if not visible"),
  amountTotal: z.number().nullable(),
  currency: nullableText.describe("ISO 4217 currency code, for example EUR"),
  supplier: partySchema,
  debtor: partySchema,
  payment: paymentFieldsSchema,
  subjectNote: nullableText,
  confidence: z.number().min(0).max(1),
  manualReviewRequired: z.boolean(),
  warnings: z.array(z.string())
});

export type InvoiceExtractionResult = z.infer<typeof invoiceExtractionResultSchema>;

export type ParsedInvoiceResult = InvoiceExtractionResult & {
  rawResult: unknown;
};

export function emptyInvoiceExtractionResult(): InvoiceExtractionResult {
  return {
    invoiceNumber: null,
    issueDate: null,
    dueDate: null,
    amountTotal: null,
    currency: null,
    supplier: {
      name: null,
      email: null,
      ico: null,
      dic: null,
      icDph: null,
      address: null
    },
    debtor: {
      name: null,
      email: null,
      ico: null,
      dic: null,
      icDph: null,
      address: null
    },
    payment: {
      iban: null,
      variableSymbol: null,
      constantSymbol: null,
      specificSymbol: null
    },
    subjectNote: null,
    confidence: 0,
    manualReviewRequired: true,
    warnings: []
  };
}

export const debtorReplyClassificationSchema = z.object({
  intent: z.enum(["PAID", "PROMISED_TO_PAY", "DISPUTE", "INSTALLMENT_REQUEST", "NEEDS_HUMAN", "IGNORE_OR_OTHER"]),
  promisedPaymentDate: nullableText,
  installmentRequested: z.boolean(),
  summary: z.string(),
  confidence: z.number().min(0).max(1),
  warnings: z.array(z.string())
});

export type DebtorReplyClassification = z.infer<typeof debtorReplyClassificationSchema>;
