import { describe, expect, it } from "vitest";
import { normalizeParty, normalizeSearchText } from "./counterparty-resolver";
import { normalizeEmailAddress } from "./email-routing";
import { validateAttachment } from "./service";
import { selectReplyAttachments } from "./reply-attachment-policy";

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

  it("limits debtor reply attachments by type, count and byte budget", () => {
    const attachment = (
      fileName: string,
      mimeType: string,
      size: number
    ) => ({
      fileName,
      mimeType,
      bytes: new Uint8Array(size)
    });
    const result = selectReplyAttachments(
      [
        attachment("proof.pdf", "application/pdf", 4),
        attachment("script.exe", "application/octet-stream", 1),
        attachment("large.png", "image/png", 6),
        attachment("extra.jpg", "image/jpeg", 1)
      ],
      {
        maxAttachments: 3,
        maxAttachmentBytes: 5,
        maxTotalBytes: 5
      }
    );

    expect(result.accepted.map(({ fileName }) => fileName)).toEqual([
      "proof.pdf"
    ]);
    expect(result.rejected.map(({ reason }) => reason)).toEqual([
      "UNSUPPORTED_TYPE",
      "FILE_TOO_LARGE",
      "TOO_MANY_ATTACHMENTS"
    ]);
  });
});
