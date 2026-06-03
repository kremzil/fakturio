export type ConfirmableInvoice = {
  invoiceNumber: string | null;
  dueDate: Date | string | null;
  amountTotal: number | null;
  debtorName: string | null;
  currency: string | null;
  warnings: string[] | null;
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
  if (!cleaned || !/^\d{4}-\d{2}-\d{2}$/.test(cleaned)) {
    return null;
  }

  const date = new Date(`${cleaned}T00:00:00.000Z`);
  return Number.isNaN(date.getTime()) ? null : date;
}

export function formatIsoDate(value: Date | string | null): string | null {
  if (!value) {
    return null;
  }

  if (typeof value === "string") {
    return value.slice(0, 10);
  }

  return value.toISOString().slice(0, 10);
}

export function validateInvoiceForWorkflow(invoice: ConfirmableInvoice): {
  errors: string[];
  currencyPatch?: string;
  warningsPatch?: string[];
} {
  const errors: string[] = [];
  const invoiceNumber = cleanText(invoice.invoiceNumber);
  const debtorName = cleanText(invoice.debtorName);
  const warnings = [...(invoice.warnings ?? [])];
  const dueDate = typeof invoice.dueDate === "string" ? parseIsoDate(invoice.dueDate) : invoice.dueDate;

  if (!invoiceNumber) {
    errors.push("Chýba číslo faktúry.");
  }

  if (!dueDate) {
    errors.push("Chýba dátum splatnosti.");
  } else {
    const year = dueDate.getUTCFullYear();
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
    warningsPatch: [...new Set(warnings)]
  };
}
