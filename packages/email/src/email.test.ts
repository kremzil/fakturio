import { Buffer } from "node:buffer";
import { describe, expect, it, vi } from "vitest";
import { buildCustomerInvoiceClarificationRequest } from "./collection-templates";
import { EmailProviderError } from "./errors";
import { FixtureEmailProvider } from "./fixture-provider";
import { parseMimeEmail } from "./mime";
import { SesEmailProvider } from "./ses-provider";

describe("email provider", () => {
  it("records fixture emails for local workflow tests", async () => {
    const provider = new FixtureEmailProvider();
    const result = await provider.sendEmail({
      from: "system@example.com",
      to: ["debtor@example.com"],
      subject: "Reminder",
      textBody: "Please pay."
    });

    expect(result.provider).toBe("fixture");
    expect(provider.sent).toHaveLength(1);
  });

  it("parses MIME thread headers, body and attachments", async () => {
    const parsed = await parseMimeEmail(
      [
        "From: Debtor <debtor@example.com>",
        "To: reply@example.com",
        "Message-ID: <reply-1@example.com>",
        "In-Reply-To: <outbound-1@example.com>",
        "References: <older@example.com> <outbound-1@example.com>",
        "Subject: Re: Invoice",
        "Content-Type: text/plain; charset=utf-8",
        "",
        "Faktúra bola uhradená."
      ].join("\r\n"),
      "ses"
    );

    expect(parsed).toMatchObject({
      provider: "ses",
      providerId: "reply-1@example.com",
      messageId: "reply-1@example.com",
      inReplyTo: "outbound-1@example.com",
      references: ["older@example.com", "outbound-1@example.com"],
      from: "debtor@example.com",
      to: ["reply@example.com"],
      subject: "Re: Invoice",
      textBody: "Faktúra bola uhradená."
    });
  });

  it("wraps SES message rejection as a permanent provider error", async () => {
    const provider = new SesEmailProvider({
      region: "eu-central-1",
      client: {
        async send() {
          const error = new Error("custom provider text");
          error.name = "MessageRejected";
          throw error;
        }
      } as never
    });

    await expect(
      provider.sendEmail({
        from: "collection@example.com",
        to: ["unverified@example.com"],
        subject: "Test",
        textBody: "Test"
      })
    ).rejects.toMatchObject({
      name: "EmailProviderError",
      code: "MESSAGE_REJECTED",
      provider: "ses",
      retryable: false
    } satisfies Partial<EmailProviderError>);
  });

  it("sends SES emails with attachments as raw MIME", async () => {
    const send = vi.fn(async () => ({ MessageId: "message-with-attachment" }));
    const provider = new SesEmailProvider({
      region: "eu-central-1",
      client: { send } as never
    });

    await provider.sendEmail({
      from: "collection@example.com",
      to: ["debtor@example.com"],
      replyTo: ["reply@example.com"],
      subject: "Faktúra FV-1",
      textBody: "Prosíme o úhradu.",
      htmlBody: "<p>Prosíme o úhradu.</p>",
      attachments: [
        {
          fileName: "faktura.pdf",
          contentType: "application/pdf",
          content: Uint8Array.from([1, 2, 3, 4])
        }
      ]
    });

    expect(send).toHaveBeenCalledTimes(1);
    const calls = send.mock.calls as unknown[][];
    const command = calls[0]?.[0] as { input?: unknown };
    expect(command.input).toMatchObject({
      Content: {
        Raw: {
          Data: expect.any(Buffer)
        }
      }
    });
    expect(JSON.stringify(command.input)).not.toContain("\"Simple\"");
  });

  it("renders invoice data table and highlighted missing fields in customer clarification emails", () => {
    const template = buildCustomerInvoiceClarificationRequest({
      invoiceNumber: null,
      sourceDocumentName: "invoice-a.pdf",
      invoiceData: {
        sourceDocumentName: "invoice-a.pdf",
        supplierName: "ABC s.r.o.",
        debtorName: "XYZ s.r.o.",
        amountTotal: 480,
        currency: "EUR",
        dueDate: "2026-07-15",
        iban: "SK1211000000002941987654"
      },
      missingFields: ["Chýba číslo faktúry."],
      warnings: ["Číslo faktúry nie je čitateľné."]
    });

    expect(template.subject).toContain("invoice-a.pdf");
    expect(template.textBody).toContain("Načítané údaje z faktúry");
    expect(template.textBody).toContain("! Chýba číslo faktúry.");
    expect(template.htmlBody).toContain("<table");
    expect(template.htmlBody).toContain("Načítané údaje z faktúry");
    expect(template.htmlBody).toContain("Chýbajúce povinné údaje");
    expect(template.htmlBody).toContain("invoice-a.pdf");
    expect(template.htmlBody).toContain("480,00 €");
  });
});
