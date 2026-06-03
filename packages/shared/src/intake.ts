export const INTAKE_SOURCES = ["UPLOAD", "EMAIL"] as const;

export type IntakeSource = (typeof INTAKE_SOURCES)[number];

export const ACCEPTED_INVOICE_MIME_TYPES = ["application/pdf", "image/jpeg", "image/png", "image/webp"] as const;

export type AcceptedInvoiceMimeType = (typeof ACCEPTED_INVOICE_MIME_TYPES)[number];

export const MAX_INVOICE_UPLOAD_BYTES = 20 * 1024 * 1024;

export function isAcceptedInvoiceMimeType(value: string): value is AcceptedInvoiceMimeType {
  return (ACCEPTED_INVOICE_MIME_TYPES as readonly string[]).includes(value);
}
