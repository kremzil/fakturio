import { Buffer } from "node:buffer";
import { describe, expect, it, vi } from "vitest";
import {
  buildCustomerExceptionNotice,
  buildCustomerInvoiceClarificationRequest,
  buildInstallmentActivated,
  buildInstallmentProposal
} from "./collection-templates";
import { EmailProviderError } from "./errors";
import { FixtureEmailProvider } from "./fixture-provider";
import { buildFirstReminderEmail } from "./first-reminder-template";
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

  it("keeps HTML intact in raw MIME emails with attachments", async () => {
    const send = vi.fn(async () => ({ MessageId: "message-with-html-attachment" }));
    const provider = new SesEmailProvider({
      region: "eu-central-1",
      client: { send } as never
    });
    const template = buildFirstReminderEmail({
      debtorName: "KPK Print s.r.o.",
      creditorName: "Viktar Melnik BY",
      creditorAddress: "40 let Pobedy, 18, kv. 48, 223053 d. Borovliany, Bielorusko",
      invoiceNumber: "032026",
      amountTotal: 1000,
      currency: "EUR",
      originalDueDate: "2026-04-30",
      requestedPaymentDate: "2026-07-11",
      iban: "BY08PJCB30140010095907845933",
      subjectNote: "Grafické služby"
    });

    await provider.sendEmail({
      from: "collection@example.com",
      to: ["debtor@example.com"],
      subject: template.subject,
      textBody: template.textBody,
      htmlBody: template.htmlBody,
      attachments: [
        {
          fileName: "faktura.pdf",
          contentType: "application/pdf",
          content: Uint8Array.from([1, 2, 3, 4])
        }
      ]
    });

    const calls = send.mock.calls as unknown[][];
    const command = calls[0]?.[0] as {
      input?: { Content?: { Raw?: { Data?: Buffer } } };
    };
    const raw = command.input?.Content?.Raw?.Data;
    expect(raw).toBeInstanceOf(Buffer);
    const parsed = await parseMimeEmail(raw!, "ses");

    expect(parsed.htmlBody).toContain("<table");
    expect(parsed.htmlBody).toContain("</td>");
    expect(parsed.htmlBody).toContain("BY08PJCB30140010095907845933");
    expect(parsed.textBody).not.toContain("</td>");
    expect(parsed.textBody).not.toContain("<td style");
    expect(parsed.textBody).not.toContain("</strong>");
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

  it("renders invoice summary tables in customer informational notices", () => {
    const template = buildCustomerExceptionNotice({
      invoiceNumber: "FV-2026-22",
      title: "Dlžník odpovedal",
      summary: "Dlžník navrhol iný postup a potrebujeme rozhodnutie.",
      caseUrl: "http://localhost:3000/?case=case-1",
      statusLine: "Automatický postup je pozastavený.",
      invoiceData: {
        invoiceNumber: "FV-2026-22",
        supplierName: "Veriteľ s.r.o.",
        debtorName: "Dlžník s.r.o.",
        amountTotal: 1200,
        currency: "EUR",
        dueDate: "2026-07-15",
        iban: "SK1211000000002941987654",
        variableSymbol: "20260022"
      }
    });

    expect(template.textBody).toContain("Dlžník navrhol iný postup");
    expect(template.htmlBody).toContain("Načítané údaje z faktúry");
    expect(template.htmlBody).toContain("FV-2026-22");
    expect(template.htmlBody).toContain("1\u00a0200,00 €");
  });

  it("renders installment schedules as structured tables", () => {
    const payments = [
      { sequence: 1, amount: 200, dueDate: "2026-07-05" },
      { sequence: 2, amount: 200, dueDate: "2026-07-19" },
      { sequence: 3, amount: 200, dueDate: "2026-08-02" },
      { sequence: 4, amount: 200, dueDate: "2026-08-16" },
      { sequence: 5, amount: 200, dueDate: "2026-08-30" }
    ];

    const proposal = buildInstallmentProposal({
      invoiceNumber: "032026",
      currency: "EUR",
      payments,
      description: "veriteľom schválený splátkový kalendár"
    });
    const activated = buildInstallmentActivated({
      invoiceNumber: "032026",
      currency: "EUR",
      payments
    });

    expect(proposal.textBody).toContain("5. splátka: 200,00 €");
    expect(proposal.htmlBody).toContain("Splátkový kalendár");
    expect(proposal.htmlBody).toContain("<table");
    expect(proposal.htmlBody).toContain("5. splátka");
    expect(activated.htmlBody).toContain("30. 8. 2026");
  });
});
