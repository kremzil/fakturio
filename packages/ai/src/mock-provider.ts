import {
  AiProvider,
  CaseSummary,
  CaseSummaryInput,
  DebtorReplyClassification,
  DebtorReplyInput,
  GenerateEmailInput,
  GeneratedEmail,
  InvoiceExtractionInput,
  emptyInvoiceExtractionResult
} from "@fakturio/shared";

export class MockAiProvider implements AiProvider {
  async extractInvoice(input: InvoiceExtractionInput) {
    const stem = input.fileName.replace(/\.[^.]+$/, "").replace(/[^\dA-Za-z-]/g, "").slice(0, 18);
    return {
      ...emptyInvoiceExtractionResult(),
      invoiceNumber: stem ? `FV-${stem}` : "FV-2026-00124",
      issueDate: "2026-05-20",
      dueDate: "2026-06-03",
      amountTotal: 480,
      currency: "EUR",
      supplier: {
        name: "ABC s.r.o.",
        email: "billing@abc.example",
        ico: "12345678",
        dic: "2020123456",
        icDph: "SK2020123456",
        address: "Hlavná 12, 811 01 Bratislava"
      },
      debtor: {
        name: "XYZ s.r.o.",
        email: "ap@xyz.example",
        ico: "87654321",
        dic: "2020654321",
        icDph: "SK2020654321",
        address: "Dlhá 4, 040 01 Košice"
      },
      payment: {
        iban: "SK1211000000002941987654",
        variableSymbol: "202600124",
        constantSymbol: null,
        specificSymbol: null
      },
      subjectNote: "Dodanie služieb podľa objednávky.",
      confidence: 0.86,
      manualReviewRequired: false,
      warnings: ["MOCK_AI režim: údaje sú ukážkové a treba ich skontrolovať."],
      rawResult: {
        mock: true,
        fileName: input.fileName,
        fileType: input.mimeType,
        fileSize: input.bytes.byteLength
      }
    };
  }

  async classifyDebtorReply(input: DebtorReplyInput): Promise<DebtorReplyClassification> {
    const lower = input.messageText.toLowerCase();
    const intent = lower.includes("paid") || lower.includes("uhraden")
      ? "PAID"
      : lower.includes("splát") || lower.includes("installment")
        ? "INSTALLMENT_REQUEST"
        : lower.includes("zaplat") || lower.includes("pay")
          ? "PROMISED_TO_PAY"
          : "IGNORE_OR_OTHER";

    return {
      intent,
      promisedPaymentDate: null,
      installmentRequested: intent === "INSTALLMENT_REQUEST",
      summary: input.messageText.slice(0, 240),
      confidence: 0.72,
      warnings: ["MOCK_AI režim: klasifikácia je ukážková."]
    };
  }

  async generateDebtorEmail(input: GenerateEmailInput): Promise<GeneratedEmail> {
    const subject = `Pripomienka úhrady faktúry ${input.invoiceNumber}`;
    const textBody = `Dobrý deň, evidujeme neuhradenú faktúru ${input.invoiceNumber} vo výške ${input.amountTotal} ${input.currency}, splatnú ${input.dueDate}. Prosíme o úhradu alebo odpoveď s informáciou o stave platby.`;

    return {
      subject,
      textBody,
      htmlBody: `<p>${textBody}</p>`,
      warnings: ["MOCK_AI režim: text emailu je šablónový."]
    };
  }

  async summarizeCase(input: CaseSummaryInput): Promise<CaseSummary> {
    return {
      summary: input.events.join("\n").slice(0, 1000),
      riskLevel: "MEDIUM",
      recommendedNextAction: "Continue according to the configured collection workflow."
    };
  }
}
