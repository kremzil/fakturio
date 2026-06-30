import { z } from "zod";

const nullableText = z.string().nullable();

export const customerMessageIntentSchema = z.enum([
  "PROVIDE_INVOICE_FIELDS",
  "ADD_CASE_NOTE",
  "ASK_CASE_STATUS",
  "ASK_MISSING_FIELDS",
  "UPDATE_DEBTOR_CONTACT",
  "REQUEST_PAUSE",
  "REQUEST_RESUME",
  "REQUEST_MARK_PAID",
  "REQUEST_CANCEL",
  "REQUEST_CONFIRM_INVOICE",
  "REQUEST_STANDARD_INSTALLMENT_PLAN",
  "REQUEST_CUSTOM_INSTALLMENT_PLAN",
  "REQUEST_SEND_DEBTOR_MESSAGE",
  "ASK_CASE_HISTORY",
  "OTHER",
  "UNSAFE_OR_LEGAL"
]);

export const customerExtractedInvoiceFieldsSchema = z.object({
  invoiceNumber: nullableText,
  dueDate: nullableText.describe("ISO date YYYY-MM-DD, or null"),
  amountTotal: z.number().positive().nullable(),
  currency: nullableText.describe("ISO 4217 currency code, or null"),
  debtorName: nullableText,
  debtorEmail: nullableText,
  supplierName: nullableText,
  iban: nullableText,
  variableSymbol: nullableText
});

export const customerDebtorContactPatchSchema = z.object({
  email: nullableText,
  name: nullableText
});

export const customerCaseReferenceSchema = z.object({
  caseId: nullableText,
  invoiceNumber: nullableText,
  debtorName: nullableText
});

export const customerMessageClassificationSchema = z.object({
  intent: customerMessageIntentSchema,
  confidence: z.number().min(0).max(1),
  summary: z.string(),
  extractedInvoiceFields: customerExtractedInvoiceFieldsSchema,
  debtorContactPatch: customerDebtorContactPatchSchema,
  caseReference: customerCaseReferenceSchema,
  customerNote: nullableText,
  requestedAction: nullableText,
  needsHumanReview: z.boolean(),
  replyDraft: nullableText
});

export type CustomerMessageIntent = z.infer<typeof customerMessageIntentSchema>;
export type CustomerMessageClassification = z.infer<typeof customerMessageClassificationSchema>;

export function emptyCustomerExtractedInvoiceFields(): z.infer<typeof customerExtractedInvoiceFieldsSchema> {
  return {
    invoiceNumber: null,
    dueDate: null,
    amountTotal: null,
    currency: null,
    debtorName: null,
    debtorEmail: null,
    supplierName: null,
    iban: null,
    variableSymbol: null
  };
}

export function emptyCustomerMessageClassification(): CustomerMessageClassification {
  return {
    intent: "OTHER",
    confidence: 0,
    summary: "",
    extractedInvoiceFields: emptyCustomerExtractedInvoiceFields(),
    debtorContactPatch: {
      email: null,
      name: null
    },
    caseReference: {
      caseId: null,
      invoiceNumber: null,
      debtorName: null
    },
    customerNote: null,
    requestedAction: null,
    needsHumanReview: true,
    replyDraft: null
  };
}
