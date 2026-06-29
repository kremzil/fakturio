import { z } from "zod";

export const invoiceEmailAttachmentTriageDecisionSchema = z.enum([
  "SEPARATE_INVOICES",
  "SINGLE_INVOICE_WITH_SUPPORTING_DOCUMENTS",
  "NEEDS_CUSTOMER_CLARIFICATION"
]);

export const invoiceEmailAttachmentGroupSchema = z.object({
  primaryInvoiceAttachmentIndex: z.number().int().min(0),
  supportingAttachmentIndexes: z.array(z.number().int().min(0)).default([]),
  reason: z.string()
});

export const invoiceEmailAttachmentTriageResultSchema = z.object({
  decision: invoiceEmailAttachmentTriageDecisionSchema,
  confidence: z.number().min(0).max(1),
  groups: z.array(invoiceEmailAttachmentGroupSchema).default([]),
  customerQuestion: z.string().nullable().default(null),
  warnings: z.array(z.string()).default([])
});

export type InvoiceEmailAttachmentTriageDecision = z.infer<
  typeof invoiceEmailAttachmentTriageDecisionSchema
>;
export type InvoiceEmailAttachmentGroup = z.infer<typeof invoiceEmailAttachmentGroupSchema>;
export type InvoiceEmailAttachmentTriageResult = z.infer<
  typeof invoiceEmailAttachmentTriageResultSchema
>;

export type InvoiceEmailAttachmentRef = {
  index: number;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  sha256: string;
};

export function validateInvoiceEmailAttachmentTriage(
  result: InvoiceEmailAttachmentTriageResult,
  attachmentCount: number,
  confidenceThreshold = 0.9
): InvoiceEmailAttachmentTriageResult {
  if (result.confidence < confidenceThreshold) {
    return needsClarification(result, "Triage confidence is below the automatic threshold.");
  }

  if (result.decision === "NEEDS_CUSTOMER_CLARIFICATION") {
    return result;
  }

  const expectedGroupCount =
    result.decision === "SEPARATE_INVOICES" ? 2 : 1;
  if (result.groups.length < expectedGroupCount) {
    return needsClarification(result, "Triage did not return enough invoice groups.");
  }

  const used = new Set<number>();
  for (const group of result.groups) {
    const indexes = [
      group.primaryInvoiceAttachmentIndex,
      ...group.supportingAttachmentIndexes
    ];
    for (const index of indexes) {
      if (index < 0 || index >= attachmentCount || used.has(index)) {
        return needsClarification(result, "Triage returned invalid or duplicate attachment indexes.");
      }
      used.add(index);
    }
  }

  if (used.size !== attachmentCount) {
    return needsClarification(result, "Triage did not account for every accepted attachment.");
  }

  return result;
}

function needsClarification(
  result: InvoiceEmailAttachmentTriageResult,
  warning: string
): InvoiceEmailAttachmentTriageResult {
  return {
    ...result,
    decision: "NEEDS_CUSTOMER_CLARIFICATION",
    groups: [],
    warnings: [...result.warnings, warning]
  };
}
