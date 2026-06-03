import { describe, expect, it } from "vitest";
import { normalizeParty, normalizeSearchText } from "./counterparty-resolver";
import { normalizeEmailAddress } from "./email-routing";
import { validateAttachment } from "./service";

describe("invoice intake", () => {
  it("accepts PDF and image invoice attachments", () => {
    expect(validateAttachment({ fileName: "invoice.pdf", mimeType: "application/pdf", bytes: new Uint8Array([1]) })).toBeNull();
    expect(validateAttachment({ fileName: "invoice.png", mimeType: "image/png", bytes: new Uint8Array([1]) })).toBeNull();
  });

  it("rejects unsupported email attachments before storage and parsing", () => {
    expect(validateAttachment({ fileName: "invoice.txt", mimeType: "text/plain", bytes: new Uint8Array([1]) })).toBe(
      "Unsupported invoice attachment type."
    );
  });

  it("normalizes counterparty identity fields for organization-scoped matching", () => {
    expect(normalizeSearchText("Július Bačo, s.r.o.")).toBe("julius baco s r o");
    expect(
      normalizeParty({
        name: " XYZ s.r.o. ",
        email: "AP@XYZ.EXAMPLE",
        ico: "87 654 321",
        dic: "SK-2020654321",
        icDph: "sk2020654321",
        address: "Dlhá 4, Košice"
      })
    ).toMatchObject({
      name: "XYZ s.r.o.",
      email: "ap@xyz.example",
      normalizedName: "xyz s r o",
      normalizedAddress: "dlha 4 kosice",
      ico: "87654321",
      dic: "SK2020654321",
      icDph: "SK2020654321"
    });
  });

  it("normalizes inbound email routing addresses", () => {
    expect(normalizeEmailAddress(" Invoices@FAKTURIO.Local ")).toBe("invoices@fakturio.local");
  });
});
