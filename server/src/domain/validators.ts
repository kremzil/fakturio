import { z } from "zod";

export const invoicePatchSchema = z
  .object({
    invoiceNumber: z.string().nullable(),
    issueDate: z.string().nullable(),
    dueDate: z.string().nullable(),
    amountTotal: z.number().nullable(),
    currency: z.string().nullable(),
    supplierName: z.string().nullable(),
    supplierIco: z.string().nullable(),
    supplierDic: z.string().nullable(),
    supplierIcDph: z.string().nullable(),
    supplierAddress: z.string().nullable(),
    debtorName: z.string().nullable(),
    debtorIco: z.string().nullable(),
    debtorDic: z.string().nullable(),
    debtorIcDph: z.string().nullable(),
    debtorAddress: z.string().nullable(),
    iban: z.string().nullable(),
    variableSymbol: z.string().nullable(),
    constantSymbol: z.string().nullable(),
    specificSymbol: z.string().nullable(),
    subjectNote: z.string().nullable()
  })
  .partial();

export type InvoicePatch = z.infer<typeof invoicePatchSchema>;

type ConfirmableInvoice = {
  invoiceNumber: string | null;
  dueDate: Date | null;
  amountTotal: number | null;
  debtorName: string | null;
  currency: string | null;
  warnings: string | null;
};

export function cleanText(value: string | null | undefined): string | null {
  if (value === undefined || value === null) {
    return null;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function parseIsoDate(value: string | null | undefined): Date | null {
  const cleaned = cleanText(value);
  if (!cleaned) {
    return null;
  }

  const match = /^\d{4}-\d{2}-\d{2}$/.test(cleaned);
  if (!match) {
    return null;
  }

  const date = new Date(`${cleaned}T00:00:00.000Z`);
  return Number.isNaN(date.getTime()) ? null : date;
}

export function formatIsoDate(value: Date | null): string | null {
  if (!value) {
    return null;
  }

  return value.toISOString().slice(0, 10);
}

export function parseWarnings(value: string | null | undefined): string[] {
  if (!value) {
    return [];
  }

  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}

export function serializeWarnings(warnings: string[]): string {
  return JSON.stringify([...new Set(warnings)]);
}

export function validateForConfirmation(invoice: ConfirmableInvoice): {
  errors: string[];
  currencyPatch?: string;
  warningsPatch?: string;
} {
  const errors: string[] = [];
  const invoiceNumber = cleanText(invoice.invoiceNumber);
  const debtorName = cleanText(invoice.debtorName);
  const warnings = parseWarnings(invoice.warnings);

  if (!invoiceNumber) {
    errors.push("Chýba číslo faktúry.");
  }

  if (!invoice.dueDate) {
    errors.push("Chýba dátum splatnosti.");
  } else {
    const year = invoice.dueDate.getUTCFullYear();
    if (year < 2000 || year > 2100) {
      errors.push("Dátum splatnosti vyzerá neplatne.");
    }
  }

  if (invoice.amountTotal === null || invoice.amountTotal === undefined) {
    errors.push("Chýba suma na úhradu.");
  } else if (invoice.amountTotal <= 0) {
    errors.push("Suma musí byť väčšia ako 0.");
  }

  if (!debtorName) {
    errors.push("Chýba odberateľ / dlžník.");
  }

  if (cleanText(invoice.currency)) {
    return { errors };
  }

  warnings.push("Mena nebola rozpoznaná. Systém nastavil EUR, skontrolujte ju.");

  return {
    errors,
    currencyPatch: "EUR",
    warningsPatch: serializeWarnings(warnings)
  };
}
