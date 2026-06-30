import { describe, expect, it } from "vitest";
import { buildFirstReminderEmail } from "./first-reminder-template";

describe("first debtor reminder template", () => {
  it("renders invoice, creditor and payment placeholders", () => {
    const email = buildFirstReminderEmail({
      debtorName: "Dlžník s.r.o.",
      creditorName: "Veriteľ s.r.o.",
      creditorAddress: "Hlavná 1, Bratislava",
      creditorIco: "12345678",
      invoiceNumber: "FV-2026-10",
      amountTotal: 480,
      currency: "EUR",
      originalDueDate: "2026-06-10",
      requestedPaymentDate: "2026-06-20",
      iban: "SK1211000000002941987654",
      variableSymbol: "20260010",
      subjectNote: "Dodanie služieb"
    });

    expect(email.subject).toContain("FV-2026-10");
    expect(email.textBody).toContain("480,00 €");
    expect(email.textBody).toContain("Veriteľ s.r.o.");
    expect(email.textBody).toContain("20. 6. 2026");
    expect(email.textBody).toContain("SK1211000000002941987654");
    expect(email.htmlBody).toContain("<!doctype html>");
    expect(email.htmlBody).toContain("max-width:640px");
    expect(email.htmlBody).toContain("Variabilný symbol");
  });

  it("escapes dynamic HTML values", () => {
    const email = buildFirstReminderEmail({
      debtorName: "<script>alert(1)</script>",
      creditorName: "A & B",
      invoiceNumber: "FV-1",
      amountTotal: 10,
      currency: "EUR",
      originalDueDate: "2026-06-10",
      requestedPaymentDate: "2026-06-20"
    });

    expect(email.htmlBody).not.toContain("<script>");
    expect(email.htmlBody).toContain("A &amp; B");
  });
});
