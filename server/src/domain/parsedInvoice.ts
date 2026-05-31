import { z } from "zod";

const nullableText = z.string().nullable();

export const parsedInvoiceDataSchema = z.object({
  invoiceNumber: nullableText,
  issueDate: nullableText.describe("ISO date YYYY-MM-DD, or null if not visible"),
  dueDate: nullableText.describe("ISO date YYYY-MM-DD, or null if not visible"),
  amountTotal: z.number().nullable(),
  currency: nullableText.describe("ISO 4217 currency code, for example EUR"),
  supplier: z.object({
    name: nullableText,
    ico: nullableText,
    dic: nullableText,
    icDph: nullableText,
    address: nullableText
  }),
  debtor: z.object({
    name: nullableText,
    ico: nullableText,
    dic: nullableText,
    icDph: nullableText,
    address: nullableText
  }),
  payment: z.object({
    iban: nullableText,
    variableSymbol: nullableText,
    constantSymbol: nullableText,
    specificSymbol: nullableText
  }),
  subjectNote: nullableText,
  confidence: z.number().min(0).max(1),
  warnings: z.array(z.string())
});

export type ParsedInvoiceData = z.infer<typeof parsedInvoiceDataSchema>;

export type ParsedInvoiceResult = ParsedInvoiceData & {
  rawResult: unknown;
};

export const emptyParsedInvoiceData = (): ParsedInvoiceData => ({
  invoiceNumber: null,
  issueDate: null,
  dueDate: null,
  amountTotal: null,
  currency: null,
  supplier: {
    name: null,
    ico: null,
    dic: null,
    icDph: null,
    address: null
  },
  debtor: {
    name: null,
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
  warnings: []
});
