import {
  AiProvider,
  CaseSummary,
  CaseSummaryInput,
  CustomerDecisionEmailDraft,
  CustomerDecisionEmailInput,
  CustomerMessageClassification,
  CustomerMessageInput,
  DashboardCaseAssistantInput,
  DashboardCaseAssistantReply,
  DebtorReplyClassification,
  DebtorReplyInput,
  GenerateEmailInput,
  GeneratedEmail,
  InvoiceEmailAttachmentTriageInput,
  InvoiceEmailAttachmentTriageResult,
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

  async classifyInvoiceEmailAttachments(
    input: InvoiceEmailAttachmentTriageInput
  ): Promise<InvoiceEmailAttachmentTriageResult> {
    const lower = `${input.subject ?? ""}\n${input.messageText ?? ""}\n${input.attachments.map((attachment) => attachment.fileName).join("\n")}`.toLowerCase();
    if (lower.includes("ambiguous") || lower.includes("nejas")) {
      return {
        decision: "NEEDS_CUSTOMER_CLARIFICATION",
        confidence: 0.61,
        groups: [],
        customerQuestion: "Prosíme upresniť, ktoré dokumenty sú faktúry a ktoré prílohy.",
        warnings: ["MOCK_AI režim: viac dokumentov je označených ako nejasných."]
      };
    }

    const supportingIndexes = input.attachments
      .filter((attachment) => /support|priloha|príloha|dodaci|dodací|objednavka|objednávka|zmluva/u.test(attachment.fileName.toLowerCase()))
      .map((attachment) => attachment.index);
    const primaryCandidates = input.attachments.filter(
      (attachment) => !supportingIndexes.includes(attachment.index)
    );

    if (supportingIndexes.length > 0 && primaryCandidates.length === 1) {
      return {
        decision: "SINGLE_INVOICE_WITH_SUPPORTING_DOCUMENTS",
        confidence: 0.94,
        groups: [
          {
            primaryInvoiceAttachmentIndex: primaryCandidates[0]?.index ?? 0,
            supportingAttachmentIndexes: supportingIndexes,
            reason: "Mock filename heuristic found one invoice and supporting documents."
          }
        ],
        customerQuestion: null,
        warnings: ["MOCK_AI režim: triage je ukážkový."]
      };
    }

    return {
      decision: "SEPARATE_INVOICES",
      confidence: 0.94,
      groups: input.attachments.map((attachment) => ({
        primaryInvoiceAttachmentIndex: attachment.index,
        supportingAttachmentIndexes: [],
        reason: "Mock filename heuristic treats each supported file as a separate invoice."
      })),
      customerQuestion: null,
      warnings: ["MOCK_AI režim: triage je ukážkový."]
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
      requestedInstallmentCount: extractPaymentCount(input.messageText),
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
    const asksStart =
      lower.includes("spusti") ||
      lower.includes("potvrd") ||
      lower.includes("start case") ||
      lower.includes("запусти");
    const asksStandardInstallment =
      lower.includes("standard") ||
      lower.includes("štandard") ||
      lower.includes("summa/3") ||
      lower.includes("сумма/3") ||
      lower.includes("стандартн");
    const asksCustomInstallment =
      !asksStandardInstallment &&
      (lower.includes("splatk") ||
        lower.includes("splátk") ||
        lower.includes("installment") ||
        lower.includes("рассроч"));
    const asksHistory =
      lower.includes("histori") ||
      lower.includes("ake kroky") ||
      lower.includes("aké kroky") ||
      lower.includes("co sa") ||
      lower.includes("čo sa") ||
      lower.includes("какие действия");
    const asksDebtorMessage =
      lower.includes("napíš") ||
      lower.includes("napis") ||
      lower.includes("pošli mu") ||
      lower.includes("posli mu") ||
      lower.includes("send debtor") ||
      lower.includes("напиши должнику");
    const asksFinalNotice =
      lower.includes("posledn") ||
      lower.includes("final notice") ||
      lower.includes("predžalob") ||
      lower.includes("predzalob") ||
      lower.includes("súd") ||
      lower.includes("sud") ||
      lower.includes("court") ||
      lower.includes("суд") ||
      lower.includes("принудительн");
    const mutating = lower.includes("označ") || lower.includes("oznac") || lower.includes("cancel") || lower.includes("zastav") || lower.includes("pauz");
    const asksStatus = lower.includes("stav") || lower.includes("status");

    const intent = asksStandardInstallment
      ? "REQUEST_STANDARD_INSTALLMENT_PLAN"
      : asksCustomInstallment
        ? "REQUEST_CUSTOM_INSTALLMENT_PLAN"
        : asksFinalNotice
          ? "REQUEST_FINAL_NOTICE"
          : asksDebtorMessage
          ? "REQUEST_SEND_DEBTOR_MESSAGE"
          : asksHistory
            ? "ASK_CASE_HISTORY"
            : asksStart
              ? "REQUEST_CONFIRM_INVOICE"
              : mutating
                ? lower.includes("uhraden") || lower.includes("paid")
                  ? "REQUEST_MARK_PAID"
                  : "REQUEST_PAUSE"
                : hasFields
                  ? "PROVIDE_INVOICE_FIELDS"
                  : asksStatus
                    ? "ASK_CASE_STATUS"
                    : "ADD_CASE_NOTE";

    return {
      intent,
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
      requestedInstallmentPlan: {
        paymentCount: asksCustomInstallment
          ? extractPaymentCount(input.messageText)
          : null,
        firstPaymentAmount: asksCustomInstallment
          ? extractFirstPaymentAmount(input.messageText)
          : null,
        paymentAmounts: [],
        dueDates: [],
        note: asksCustomInstallment ? input.messageText.slice(0, 240) : null
      },
      customerNote: hasFields ? null : input.messageText.slice(0, 500),
      requestedAction:
        mutating || asksStart || asksStandardInstallment || asksCustomInstallment || asksDebtorMessage || asksFinalNotice
          ? input.messageText.slice(0, 240)
          : null,
      needsHumanReview: false,
      replyDraft: asksCustomInstallment || asksDebtorMessage ? input.messageText.slice(0, 500) : null
    };
  }

  async answerDashboardCaseMessage(
    input: DashboardCaseAssistantInput
  ): Promise<DashboardCaseAssistantReply> {
    const latestDebtor = input.recentCommunications.find(
      (message) =>
        message.direction === "INBOUND" &&
        message.kind !== "customer-email-assistant-message" &&
        message.textBody
    );
    const amount =
      input.caseSnapshot.amountTotal !== null
        ? `${input.caseSnapshot.amountTotal.toFixed(2)} ${input.caseSnapshot.currency ?? "EUR"}`
        : "nezadaná";
    const paused = input.caseSnapshot.automationPaused
      ? input.userLanguage === "ru"
        ? `Автоматизация на паузе: ${input.caseSnapshot.automationPauseReason ?? "причина не указана"}.`
        : `Automatizácia je pozastavená: ${input.caseSnapshot.automationPauseReason ?? "dôvod nie je uvedený"}.`
      : input.userLanguage === "ru"
        ? "Автоматизация сейчас не на паузе."
        : "Automatizácia teraz nie je pozastavená.";

    if (input.userLanguage === "ru") {
      return {
        subject: `Ситуация по делу ${input.caseSnapshot.invoiceNumber ?? input.caseId}`,
        textBody: [
          `По делу ${input.caseSnapshot.invoiceNumber ?? input.caseId}: должник ${input.caseSnapshot.debtorName ?? "не указан"}, сумма ${amount}, срок оплаты ${input.caseSnapshot.dueDate ?? "не указан"}.`,
          paused,
          latestDebtor?.textBody
            ? `Последний ответ должника: “${latestDebtor.textBody.slice(0, 280)}”`
            : "Последнего читаемого ответа должника в контексте нет.",
          input.allowedActions.length > 0
            ? `Дальше можно: ${input.allowedActions.join(", ")}.`
            : "Сейчас нет доступных автоматических действий."
        ].join("\n\n"),
        suggestedActions: input.allowedActions,
        needsHumanDecision: input.caseSnapshot.automationPaused
      };
    }

    return {
      subject: `Situácia k prípadu ${input.caseSnapshot.invoiceNumber ?? input.caseId}`,
      textBody: [
        `K prípadu ${input.caseSnapshot.invoiceNumber ?? input.caseId}: dlžník ${input.caseSnapshot.debtorName ?? "nezadaný"}, suma ${amount}, splatnosť ${input.caseSnapshot.dueDate ?? "nezadaná"}.`,
        paused,
        latestDebtor?.textBody
          ? `Posledná odpoveď dlžníka: „${latestDebtor.textBody.slice(0, 280)}“`
          : "V kontexte nie je posledná čitateľná odpoveď dlžníka.",
        input.allowedActions.length > 0
          ? `Ďalej môžete: ${input.allowedActions.join(", ")}.`
          : "Momentálne nie je dostupná automatická akcia."
      ].join("\n\n"),
      suggestedActions: input.allowedActions,
      needsHumanDecision: input.caseSnapshot.automationPaused
    };
  }

  async draftCustomerDecisionEmail(
    input: CustomerDecisionEmailInput
  ): Promise<CustomerDecisionEmailDraft> {
    const invoice = input.invoiceNumber || input.caseId;
    const debtor = input.debtorName ?? "dlžník";
    const amount =
      input.amountTotal !== null
        ? `${input.amountTotal.toFixed(2)} ${input.currency ?? "EUR"}`
        : "nezadaná suma";
    return {
      subject: `FAKTURIO: potrebujeme rozhodnutie k ${invoice}`,
      textBody: [
        "Dobrý deň,",
        "",
        `pri faktúre ${invoice} je automatizácia pozastavená, pretože potrebujeme Vaše rozhodnutie.`,
        `Dlžník ${debtor} odpovedal k prípadu. Evidovaná suma je ${amount}.`,
        input.debtorMessage
          ? `Z odpovede dlžníka: „${input.debtorMessage.slice(0, 500)}“`
          : "Odpoveď dlžníka nemá čitateľný text.",
        "",
        `Dôvod pozastavenia: ${input.decisionReason}`,
        "",
        "Môžete odpovedať priamo na tento email napríklad:",
        ...input.allowedReplies.map((reply) => `- ${reply}`),
        "",
        `Prípad v dashboarde: ${input.caseUrl}`,
        "",
        "Ďakujeme."
      ].join("\n"),
      summaryForAudit: `Mock customer decision email drafted for ${invoice}.`
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

function extractPaymentCount(value: string): number | null {
  const lower = value.toLowerCase();
  const digit = lower.match(
    /(?:na|do|v|into|for|раздели(?:ть)?\s+на)\s+(\d{1,2})\s*(?:spl[aá]tk|payment|платеж|платёж)/u
  );
  if (digit) {
    return Number(digit[1]);
  }
  const words: Record<string, number> = {
    dve: 2,
    dva: 2,
    tri: 3,
    styri: 4,
    štyri: 4,
    pat: 5,
    päť: 5,
    five: 5,
    пять: 5
  };
  for (const [word, count] of Object.entries(words)) {
    if (lower.includes(`${word} spl`) || lower.includes(`${word} плат`)) {
      return count;
    }
  }
  return null;
}

function extractFirstPaymentAmount(value: string): number | null {
  const lower = value.toLowerCase();
  const match = lower.match(
    /(?:prv[aá]|first|первы[йя]|1\.?)\s+(?:spl[aá]tka|payment|оплат[ауы]|плат[её]ж)[^\d]*(\d+(?:[,.]\d{1,2})?)/u
  );
  return match ? Number(match[1].replace(",", ".")) : null;
}
