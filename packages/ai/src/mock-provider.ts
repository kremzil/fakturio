import {
  AiProvider,
  CaseSummary,
  CaseSummaryInput,
  CustomerMessageClassification,
  CustomerMessageInput,
  DebtorReplyClassification,
  DebtorReplyInput,
  GenerateEmailInput,
  GeneratedEmail,
  InvoiceExtractionInput,
  emptyCustomerExtractedInvoiceFields,
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
      : lower.includes("súhlas") || lower.includes("accept")
        ? "INSTALLMENT_ACCEPTED"
        : lower.includes("nesúhlas") || lower.includes("reject")
          ? "INSTALLMENT_REJECTED"
      : lower.includes("splát") || lower.includes("installment")
        ? "INSTALLMENT_REQUEST"
        : lower.includes("zaplat") || lower.includes("pay")
          ? "PROMISED_TO_PAY"
          : "IGNORE_OR_OTHER";

    return {
      intent,
      promisedPaymentDate: null,
      installmentRequested: intent === "INSTALLMENT_REQUEST",
      explicitInstallmentAcceptance: intent === "INSTALLMENT_ACCEPTED",
      mentionedPaymentAmount: null,
      summary: input.messageText.slice(0, 240),
      confidence: 0.72,
      warnings: ["MOCK_AI režim: klasifikácia je ukážková."]
    };
  }

  async classifyCustomerMessage(input: CustomerMessageInput): Promise<CustomerMessageClassification> {
    const lower = input.messageText.toLowerCase();
    const fields = emptyCustomerExtractedInvoiceFields();
    for (const line of input.messageText.split(/\r?\n/)) {
      const match = line.match(/^\s*([^:=-]{2,40})\s*[:=-]\s*(.+?)\s*$/u);
      if (!match) {
        continue;
      }
      const label = (match[1] ?? "")
        .trim()
        .toLowerCase()
        .normalize("NFD")
        .replace(/\p{Diacritic}/gu, "");
      const value = (match[2] ?? "").trim();
      if (!value) {
        continue;
      }
      if (/(cislo|faktura|invoice)/u.test(label)) {
        fields.invoiceNumber = value;
      } else if (/(splatnost|due)/u.test(label)) {
        fields.dueDate = normalizeMockDate(value);
      } else if (/(suma|amount|celkom)/u.test(label)) {
        fields.amountTotal = normalizeMockAmount(value);
      } else if (/(mena|currency)/u.test(label)) {
        fields.currency = value.toUpperCase().slice(0, 3);
      } else if (/(odberatel|dlznik|debtor)/u.test(label)) {
        fields.debtorName = value;
      } else if (/email/u.test(label)) {
        fields.debtorEmail = value.toLowerCase();
      } else if (/(dodavatel|supplier|veritel)/u.test(label)) {
        fields.supplierName = value;
      } else if (/iban/u.test(label)) {
        fields.iban = value.replace(/\s+/g, "").toUpperCase();
      } else if (/(variabilny|vs|symbol)/u.test(label)) {
        fields.variableSymbol = value.replace(/\s+/g, "");
      }
    }

    const hasFields = Object.values(fields).some((value) => value !== null);
    const mutating = lower.includes("označ") || lower.includes("oznac") || lower.includes("cancel") || lower.includes("zastav") || lower.includes("pauz");
    const asksStatus = lower.includes("stav") || lower.includes("status");

    return {
      intent: mutating
        ? lower.includes("uhraden") || lower.includes("paid")
          ? "REQUEST_MARK_PAID"
          : "REQUEST_PAUSE"
        : hasFields
          ? "PROVIDE_INVOICE_FIELDS"
          : asksStatus
            ? "ASK_CASE_STATUS"
            : "ADD_CASE_NOTE",
      confidence: 0.86,
      summary: input.messageText.slice(0, 240),
      extractedInvoiceFields: fields,
      debtorContactPatch: {
        email: fields.debtorEmail,
        name: fields.debtorName
      },
      caseReference: {
        caseId: input.candidateCases?.[0]?.caseId ?? null,
        invoiceNumber: fields.invoiceNumber,
        debtorName: fields.debtorName
      },
      customerNote: hasFields ? null : input.messageText.slice(0, 500),
      requestedAction: mutating ? input.messageText.slice(0, 240) : null,
      needsHumanReview: false,
      replyDraft: null
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

function normalizeMockDate(value: string): string | null {
  const iso = value.match(/\b(\d{4})-(\d{2})-(\d{2})\b/);
  if (iso) {
    return `${iso[1]}-${iso[2]}-${iso[3]}`;
  }
  const slovak = value.match(/\b(\d{1,2})\.\s*(\d{1,2})\.\s*(\d{4})\b/);
  if (!slovak) {
    return null;
  }
  return `${slovak[3]}-${slovak[2]?.padStart(2, "0")}-${slovak[1]?.padStart(2, "0")}`;
}

function normalizeMockAmount(value: string): number | null {
  const match = value.replace(/\s+/g, "").match(/-?\d+(?:[,.]\d{1,2})?/);
  if (!match) {
    return null;
  }
  const parsed = Number.parseFloat(match[0].replace(",", "."));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}
