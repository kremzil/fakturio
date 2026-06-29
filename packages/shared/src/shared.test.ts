import { describe, expect, it } from "vitest";
import { assertCaseTransition, canTransitionCase } from "./case-status";
import { customerMessageClassificationSchema } from "./customer-message";
import { invoiceExtractionResultSchema } from "./invoice";
import { validateInvoiceForWorkflow } from "./validation";

describe("shared domain", () => {
  it("parses the invoice extraction schema", () => {
    const parsed = invoiceExtractionResultSchema.parse({
      invoiceNumber: "52606 00029",
      issueDate: "2026-06-01",
      dueDate: "2026-06-02",
      amountTotal: 64.73,
      currency: "EUR",
      supplier: { name: "SHARK.SK j.s.a.", email: null, ico: "51154439", dic: null, icDph: null, address: null },
      debtor: { name: "Július Bačo", email: null, ico: null, dic: null, icDph: null, address: null },
      payment: { iban: "SK4175000000004025159032", variableSymbol: "5260600029", constantSymbol: null, specificSymbol: null },
      subjectNote: "Reklamné tabule",
      confidence: 0.98,
      manualReviewRequired: false,
      warnings: []
    });

    expect(parsed.invoiceNumber).toBe("52606 00029");
  });

  it("defaults missing currency to EUR during workflow validation", () => {
    const result = validateInvoiceForWorkflow({
      invoiceNumber: "FV-1",
      dueDate: "2026-06-03",
      amountTotal: 20,
      debtorName: "Dlžník s.r.o.",
      currency: null,
      warnings: []
    });

    expect(result.errors).toEqual([]);
    expect(result.currencyPatch).toBe("EUR");
  });

  it("blocks unsupported direct legal action transitions", () => {
    expect(canTransitionCase("OVERDUE", "READY_FOR_LEGAL_ACTION")).toBe(false);
    expect(canTransitionCase("FINAL_NOTICE_SENT", "READY_FOR_LEGAL_ACTION")).toBe(true);
    expect(canTransitionCase("INSTALLMENT_PLAN_SENT", "EMAIL_REMINDER_1_SENT")).toBe(true);
    expect(() =>
      assertCaseTransition("OVERDUE", "READY_FOR_LEGAL_ACTION")
    ).toThrow(/Unsupported case transition/);
  });

  it("parses customer message classification schema", () => {
    const parsed = customerMessageClassificationSchema.parse({
      intent: "PROVIDE_INVOICE_FIELDS",
      confidence: 0.91,
      summary: "Customer clarified missing invoice fields.",
      extractedInvoiceFields: {
        invoiceNumber: "FV-1",
        dueDate: "2026-07-15",
        amountTotal: 480,
        currency: "EUR",
        debtorName: "Dlžník s.r.o.",
        debtorEmail: null,
        supplierName: null,
        iban: null,
        variableSymbol: null
      },
      debtorContactPatch: {
        email: null,
        name: null
      },
      caseReference: {
        caseId: null,
        invoiceNumber: "FV-1",
        debtorName: null
      },
      customerNote: null,
      requestedAction: null,
      needsHumanReview: false,
      replyDraft: null
    });

    expect(parsed.intent).toBe("PROVIDE_INVOICE_FIELDS");
  });
});
