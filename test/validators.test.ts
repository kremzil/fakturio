// @vitest-environment node
import { describe, expect, it } from "vitest";
import { parseIsoDate, serializeWarnings, validateForConfirmation } from "../server/src/domain/validators";

describe("invoice confirmation validation", () => {
  it("blocks missing required fields", () => {
    const result = validateForConfirmation({
      invoiceNumber: null,
      dueDate: null,
      amountTotal: null,
      debtorName: null,
      currency: "EUR",
      warnings: null
    });

    expect(result.errors).toContain("Chýba číslo faktúry.");
    expect(result.errors).toContain("Chýba dátum splatnosti.");
    expect(result.errors).toContain("Chýba suma na úhradu.");
    expect(result.errors).toContain("Chýba odberateľ / dlžník.");
  });

  it("defaults missing currency to EUR with a warning", () => {
    const result = validateForConfirmation({
      invoiceNumber: "2026-001",
      dueDate: parseIsoDate("2026-06-03"),
      amountTotal: 120,
      debtorName: "XYZ s.r.o.",
      currency: null,
      warnings: serializeWarnings(["Skontrolujte IBAN."])
    });

    expect(result.errors).toEqual([]);
    expect(result.currencyPatch).toBe("EUR");
    expect(result.warningsPatch).toContain("Mena nebola rozpoznaná");
    expect(result.warningsPatch).toContain("Skontrolujte IBAN.");
  });

  it("blocks non-positive amount and absurd due date", () => {
    const result = validateForConfirmation({
      invoiceNumber: "2026-001",
      dueDate: parseIsoDate("2200-01-01"),
      amountTotal: 0,
      debtorName: "XYZ s.r.o.",
      currency: "EUR",
      warnings: null
    });

    expect(result.errors).toContain("Dátum splatnosti vyzerá neplatne.");
    expect(result.errors).toContain("Suma musí byť väčšia ako 0.");
  });
});
