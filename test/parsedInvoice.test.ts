// @vitest-environment node
import { describe, expect, it } from "vitest";
import { parsedInvoiceDataSchema } from "../server/src/domain/parsedInvoice";

describe("parsed invoice schema", () => {
  it("accepts the expected structured output shape", () => {
    const parsed = parsedInvoiceDataSchema.parse({
      invoiceNumber: "FV-2026-00124",
      issueDate: "2026-05-20",
      dueDate: "2026-06-03",
      amountTotal: 480,
      currency: "EUR",
      supplier: {
        name: "ABC s.r.o.",
        ico: "12345678",
        dic: "2020123456",
        icDph: "SK2020123456",
        address: "Hlavná 12, Bratislava"
      },
      debtor: {
        name: "XYZ s.r.o.",
        ico: "87654321",
        dic: null,
        icDph: null,
        address: null
      },
      payment: {
        iban: "SK1211000000002941987654",
        variableSymbol: "202600124",
        constantSymbol: null,
        specificSymbol: null
      },
      subjectNote: "Dodanie služieb",
      confidence: 0.91,
      warnings: []
    });

    expect(parsed.invoiceNumber).toBe("FV-2026-00124");
    expect(parsed.debtor.name).toBe("XYZ s.r.o.");
  });

  it("rejects confidence outside 0..1", () => {
    expect(() =>
      parsedInvoiceDataSchema.parse({
        invoiceNumber: null,
        issueDate: null,
        dueDate: null,
        amountTotal: null,
        currency: null,
        supplier: { name: null, ico: null, dic: null, icDph: null, address: null },
        debtor: { name: null, ico: null, dic: null, icDph: null, address: null },
        payment: { iban: null, variableSymbol: null, constantSymbol: null, specificSymbol: null },
        subjectNote: null,
        confidence: 1.5,
        warnings: []
      })
    ).toThrow();
  });
});
