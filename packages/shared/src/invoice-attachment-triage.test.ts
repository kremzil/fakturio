import { describe, expect, it } from "vitest";
import { validateInvoiceEmailAttachmentTriage } from "./invoice-attachment-triage";

describe("invoice email attachment triage", () => {
  it("keeps valid single-invoice supporting-document groups", () => {
    const result = validateInvoiceEmailAttachmentTriage(
      {
        decision: "SINGLE_INVOICE_WITH_SUPPORTING_DOCUMENTS",
        confidence: 0.94,
        groups: [
          {
            primaryInvoiceAttachmentIndex: 0,
            supportingAttachmentIndexes: [1],
            reason: "The first attachment is the invoice and the second is supporting evidence."
          }
        ],
        customerQuestion: null,
        warnings: []
      },
      2
    );

    expect(result.decision).toBe("SINGLE_INVOICE_WITH_SUPPORTING_DOCUMENTS");
    expect(result.groups[0]?.supportingAttachmentIndexes).toEqual([1]);
  });

  it("routes low confidence to customer clarification", () => {
    const result = validateInvoiceEmailAttachmentTriage(
      {
        decision: "SEPARATE_INVOICES",
        confidence: 0.89,
        groups: [
          {
            primaryInvoiceAttachmentIndex: 0,
            supportingAttachmentIndexes: [],
            reason: "Looks like one invoice."
          },
          {
            primaryInvoiceAttachmentIndex: 1,
            supportingAttachmentIndexes: [],
            reason: "Looks like another invoice."
          }
        ],
        customerQuestion: null,
        warnings: []
      },
      2
    );

    expect(result.decision).toBe("NEEDS_CUSTOMER_CLARIFICATION");
    expect(result.groups).toEqual([]);
    expect(result.warnings.join(" ")).toContain("confidence");
  });

  it("routes duplicate indexes to customer clarification", () => {
    const result = validateInvoiceEmailAttachmentTriage(
      {
        decision: "SEPARATE_INVOICES",
        confidence: 0.95,
        groups: [
          {
            primaryInvoiceAttachmentIndex: 0,
            supportingAttachmentIndexes: [],
            reason: "First group."
          },
          {
            primaryInvoiceAttachmentIndex: 0,
            supportingAttachmentIndexes: [],
            reason: "Duplicate group."
          }
        ],
        customerQuestion: null,
        warnings: []
      },
      2
    );

    expect(result.decision).toBe("NEEDS_CUSTOMER_CLARIFICATION");
    expect(result.warnings.join(" ")).toContain("duplicate");
  });
});
