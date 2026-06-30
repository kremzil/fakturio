import { escapeHtml, formatEmailDate, formatEmailMoney, renderEmailDocument } from "./format";

export type InstallmentScheduleRow = {
  sequence: number;
  amount: number;
  dueDate: string;
};

export type CollectionTemplate = {
  subject: string;
  textBody: string;
  htmlBody: string;
};

export type InvoiceEmailSummary = {
  sourceDocumentName?: string | null;
  invoiceNumber?: string | null;
  supplierName?: string | null;
  debtorName?: string | null;
  amountTotal?: number | null;
  currency?: string | null;
  dueDate?: string | Date | null;
  iban?: string | null;
  variableSymbol?: string | null;
};

export function buildNeutralPaymentReply(input: {
  invoiceNumber: string;
  paymentDate: string;
}): CollectionTemplate {
  return template(
    `Úhrada faktúry ${input.invoiceNumber}`,
    [
      "Dobrý deň,",
      "",
      "ďakujeme za Vašu odpoveď.",
      `Prosíme o úhradu faktúry ${input.invoiceNumber} najneskôr do ${input.paymentDate}.`,
      "Ak ste už platbu odoslali, informáciu preveríme s veriteľom.",
      "",
      "Ďakujeme."
    ]
  );
}

export function buildPaymentClaimAcknowledgement(input: {
  invoiceNumber: string;
}): CollectionTemplate {
  return template(
    `Overenie úhrady faktúry ${input.invoiceNumber}`,
    [
      "Dobrý deň,",
      "",
      `ďakujeme za informáciu o úhrade faktúry ${input.invoiceNumber}.`,
      "Prijatie platby teraz overíme s veriteľom.",
      "",
      "Ďakujeme."
    ]
  );
}

export function buildExistingDeadlineReply(input: {
  invoiceNumber: string;
  paymentDate: string;
}): CollectionTemplate {
  return template(
    `Termín úhrady faktúry ${input.invoiceNumber}`,
    [
      "Dobrý deň,",
      "",
      "ďakujeme za Vašu odpoveď.",
      `Pri faktúre ${input.invoiceNumber} zostáva evidovaný už dohodnutý termín úhrady ${input.paymentDate}.`,
      "Ďalšia správa automaticky nemení tento termín.",
      "",
      "Ďakujeme."
    ]
  );
}

export function buildClarificationRequest(input: {
  invoiceNumber: string;
}): CollectionTemplate {
  return template(
    `Spresnenie odpovede k faktúre ${input.invoiceNumber}`,
    [
      "Dobrý deň,",
      "",
      `prosíme o konkrétne vyjadrenie k faktúre ${input.invoiceNumber}:`,
      "- bola už uhradená,",
      "- bude uhradená ku konkrétnemu dátumu,",
      "- faktúru namietate, alebo",
      "- žiadate splátkový kalendár.",
      "",
      "Ďakujeme."
    ]
  );
}

export function buildDisputeAcknowledgement(input: {
  invoiceNumber: string;
}): CollectionTemplate {
  return template(
    `Námietka k faktúre ${input.invoiceNumber}`,
    [
      "Dobrý deň,",
      "",
      `Vašu námietku k faktúre ${input.invoiceNumber} sme zaevidovali a odovzdali veriteľovi.`,
      "Do vyhodnotenia námietky automatické upomienky pozastavujeme.",
      "",
      "Ďakujeme."
    ]
  );
}

export function buildInstallmentProposal(input: {
  invoiceNumber: string;
  currency: string;
  payments: InstallmentScheduleRow[];
}): CollectionTemplate {
  const rows = input.payments.map(
    (payment) =>
      `${payment.sequence}. splátka: ${formatEmailMoney(payment.amount, input.currency)}, splatná ${formatEmailDate(payment.dueDate)}`
  );
  return template(
    `Návrh splátkového kalendára k faktúre ${input.invoiceNumber}`,
    [
      "Dobrý deň,",
      "",
      `k faktúre ${input.invoiceNumber} navrhujeme tento štandardný splátkový kalendár:`,
      ...rows,
      "",
      "Prosíme, potvrďte výslovne, že súhlasíte so všetkými uvedenými sumami a dátumami.",
      "",
      "Ďakujeme."
    ]
  );
}

export function buildInstallmentActivated(input: {
  invoiceNumber: string;
  payments: InstallmentScheduleRow[];
  currency: string;
}): CollectionTemplate {
  return template(
    `Potvrdenie splátkového kalendára k faktúre ${input.invoiceNumber}`,
    [
      "Dobrý deň,",
      "",
      "Vaše výslovné prijatie splátkového kalendára sme zaevidovali.",
      ...input.payments.map(
        (payment) =>
          `${payment.sequence}. splátka: ${formatEmailMoney(payment.amount, input.currency)}, splatná ${formatEmailDate(payment.dueDate)}`
      ),
      "",
      "Dodržanie jednotlivých termínov budeme priebežne overovať.",
      "",
      "Ďakujeme."
    ]
  );
}

export function buildSecondReminder(input: {
  invoiceNumber: string;
  amountTotal: number;
  currency: string;
  creditorName: string;
}): CollectionTemplate {
  return template(
    `Druhá výzva na úhradu faktúry ${input.invoiceNumber}`,
    [
      "Dobrý deň,",
      "",
      `napriek predchádzajúcej upomienke eviduje ${input.creditorName} faktúru ${input.invoiceNumber} vo výške ${formatEmailMoney(input.amountTotal, input.currency)} ako neuhradenú.`,
      "Žiadame Vás o bezodkladnú úhradu alebo okamžité kontaktovanie FAKTURIO či veriteľa s konkrétnym návrhom riešenia.",
      "Ak sa vec nevyrieši, veriteľ môže zvážiť ďalšie kroky na vymáhanie pohľadávky vrátane súdneho uplatnenia.",
      "",
      "Táto správa neznamená, že súdne konanie už bolo začaté."
    ]
  );
}

export function buildInstallmentBrokenNotice(input: {
  invoiceNumber: string;
  missedSequence: number;
  missedAmount: number;
  currency: string;
  remainingAmount: number;
}): CollectionTemplate {
  return template(
    `Porušenie splátkového kalendára k faktúre ${input.invoiceNumber}`,
    [
      "Dobrý deň,",
      "",
      `veriteľ nepotvrdil prijatie ${input.missedSequence}. splátky vo výške ${formatEmailMoney(input.missedAmount, input.currency)}.`,
      "Splátkový kalendár preto evidujeme ako porušený.",
      `Prosíme o bezodkladné kontaktovanie FAKTURIO alebo veriteľa a vyriešenie zostávajúcej sumy ${formatEmailMoney(input.remainingAmount, input.currency)}.`,
      "",
      "Ďakujeme."
    ]
  );
}

export function buildCustomerAuthorizedDebtorMessage(input: {
  invoiceNumber: string;
  message: string;
}): CollectionTemplate {
  return template(
    `Správa veriteľa k faktúre ${input.invoiceNumber}`,
    [
      "Dobrý deň,",
      "",
      `k faktúre ${input.invoiceNumber} Vám posielame správu podľa pokynu veriteľa:`,
      "",
      input.message,
      "",
      "Prosíme, odpovedzte priamo na tento email.",
      "",
      "Ďakujeme."
    ]
  );
}

export function buildDebtorInvoiceCopy(input: {
  invoiceNumber: string;
}): CollectionTemplate {
  return template(
    `Kópia faktúry ${input.invoiceNumber}`,
    [
      "Dobrý deň,",
      "",
      `v prílohe posielame kópiu faktúry ${input.invoiceNumber}.`,
      "Prosíme, odpovedzte priamo na tento email, ak potrebujete doplniť ďalšie informácie.",
      "",
      "Ďakujeme."
    ]
  );
}

export function buildCustomerExceptionNotice(input: {
  invoiceNumber: string;
  title: string;
  summary: string;
  caseUrl: string;
}): CollectionTemplate {
  return template(
    `FAKTURIO: ${input.title} - ${input.invoiceNumber}`,
    [
      "Dobrý deň,",
      "",
      input.summary,
      `Prípad: ${input.caseUrl}`,
      "",
      "Automatický postup bol pozastavený."
    ]
  );
}

export function buildCustomerDebtorReplyDecisionRequest(input: {
  invoiceNumber: string;
  debtorName: string | null;
  debtorMessage: string | null;
  reason: string;
  caseUrl: string;
}): CollectionTemplate {
  return template(
    `FAKTURIO: potrebujeme rozhodnutie k ${input.invoiceNumber}`,
    [
      "Dobrý deň,",
      "",
      `Dlžník odpovedal k faktúre ${input.invoiceNumber}.`,
      input.debtorName ? `Dlžník: ${input.debtorName}` : "",
      "",
      "Správa dlžníka:",
      input.debtorMessage ? `„${input.debtorMessage}“` : "Správa nemá čitateľný text.",
      "",
      "Automatizácia potrebuje vaše rozhodnutie:",
      input.reason,
      "",
      "Môžete odpovedať priamo na tento email napríklad:",
      "- pošlite dlžníkovi štandardný splátkový kalendár,",
      "- pošlite mu doplňujúcu správu: ...",
      "- pokračujte štandardným spôsobom,",
      "- pozastavte prípad.",
      "",
      `Prípad v dashboarde: ${input.caseUrl}`,
      "",
      "Ďakujeme."
    ].filter((line) => line !== "")
  );
}

export function buildCustomerInvoiceClarificationRequest(input: {
  invoiceNumber: string | null;
  sourceDocumentName?: string | null;
  invoiceData?: InvoiceEmailSummary | null;
  missingFields: string[];
  warnings: string[];
}): CollectionTemplate {
  const sourceDocumentName = input.sourceDocumentName?.trim() || null;
  const invoiceData = {
    ...(input.invoiceData ?? {}),
    sourceDocumentName: input.invoiceData?.sourceDocumentName ?? sourceDocumentName,
    invoiceNumber: input.invoiceData?.invoiceNumber ?? input.invoiceNumber
  };
  const reference = input.invoiceNumber
    ? `faktúre ${input.invoiceNumber}`
    : sourceDocumentName
      ? `dokumentu ${sourceDocumentName}`
      : "novej faktúre";
  const missing =
    input.missingFields.length > 0
      ? input.missingFields
      : ["údaje označené v aplikácii ako nejasné"];
  const contextLines = sourceDocumentName
    ? ["", `Týka sa dokumentu: ${sourceDocumentName}`]
    : [];
  const warningLines =
    input.warnings.length > 0
      ? ["", "Poznámky z automatického spracovania:", ...input.warnings.map((item) => `- ${item}`)]
      : [];
  const subjectReference =
    sourceDocumentName && input.invoiceNumber
      ? `${reference} (${sourceDocumentName})`
      : reference;
  const invoiceLines = invoiceSummaryTextLines(invoiceData);

  return template(
    `FAKTURIO: potrebujeme doplniť údaje k ${subjectReference}`,
    [
      "Dobrý deň,",
      "",
      `pri spracovaní ${reference} sa nepodarilo spoľahlivo načítať všetky údaje potrebné na založenie prípadu.`,
      ...contextLines,
      "",
      "Načítané údaje z faktúry:",
      ...invoiceLines,
      "",
      "Chýbajúce povinné údaje:",
      ...missing.map((field) => `! ${field}`),
      "",
      "Prosíme, odpovedzte na tento email a doplňte:",
      ...missing.map((field) => `- ${field}`),
      ...warningLines,
      "",
      "Nižšie je iba ukážka formátu odpovede. Nie sú to údaje z Vašej faktúry:",
      "--- PRÍKLAD FORMÁTU ---",
      "Číslo faktúry: napr. FV-2026-001",
      "Dátum splatnosti: napr. 2026-07-15",
      "Suma: napr. 480,00",
      "Mena: napr. EUR",
      "Odberateľ: napr. Názov dlžníka s.r.o.",
      "IBAN: napr. SK...",
      "Variabilný symbol: napr. 2026001",
      "--- KONIEC PRÍKLADU ---",
      "",
      "Ďakujeme."
    ],
    {
      afterParagraph: 2,
      bodyHtml: [
        renderInvoiceSummaryTable(invoiceData, missing),
        renderMissingFieldsBox(missing)
      ].join(""),
      skipHtmlPrefixes: [
        "Týka sa dokumentu:",
        "Načítané údaje z faktúry:",
        "Chýbajúce povinné údaje:",
        "- Dokument:",
        "- Číslo faktúry:",
        "- Dodávateľ:",
        "- Odberateľ:",
        "- Suma:",
        "- Splatnosť:",
        "- IBAN:",
        "- Variabilný symbol:",
        "! "
      ]
    }
  );
}

export function buildCustomerMultiAttachmentClarificationRequest(input: {
  attachmentNames: string[];
  question?: string | null;
}): CollectionTemplate {
  return template(
    "FAKTURIO: potrebujeme upresniť priložené dokumenty",
    [
      "Dobrý deň,",
      "",
      "v prijatom emaile sme našli viac dokumentov a nevieme ich bezpečne automaticky rozdeliť.",
      input.question ||
        "Prosíme, potvrďte, ktoré dokumenty sú samostatné faktúry a ktoré sú prílohy k jednej faktúre.",
      "",
      "Prijaté dokumenty:",
      ...input.attachmentNames.map((name, index) => `${index + 1}. ${name}`),
      "",
      "Môžete odpovedať napríklad:",
      "1 a 2 sú samostatné faktúry",
      "alebo",
      "1 je faktúra, 2 a 3 sú prílohy k faktúre 1",
      "",
      "Kým to nepotvrdíte, automatické založenie prípadu pozastavíme.",
      "",
      "Ďakujeme."
    ]
  );
}

export function buildCustomerAssistantAcknowledgement(input: {
  invoiceNumber: string | null;
  summary: string;
  stillMissing: string[];
  confirmUrl?: string | null;
  dashboardUrl?: string | null;
}): CollectionTemplate {
  const reference = input.invoiceNumber || "prípadu";
  const missing =
    input.stillMissing.length > 0
      ? ["", "Stále potrebujeme doplniť:", ...input.stillMissing.map((field) => `- ${field}`)]
      : ["", "Aktualizované údaje sú pripravené na kontrolu v aplikácii."];

  return template(
    `FAKTURIO: odpoveď k ${reference} sme spracovali`,
    [
      "Dobrý deň,",
      "",
      "ďakujeme za odpoveď. Informácie sme zaevidovali k prípadu.",
      input.summary,
      ...missing,
      input.confirmUrl
        ? `Ak sú údaje správne, potvrďte spustenie kontroly tu: ${input.confirmUrl}`
        : "",
      input.dashboardUrl ? `Prípad v dashboarde: ${input.dashboardUrl}` : "",
      "",
      "Ďakujeme."
    ].filter((line) => line !== "")
  );
}

export function buildCustomerMissingFieldsFollowUp(input: {
  invoiceNumber: string | null;
  stillMissing: string[];
  dashboardUrl?: string | null;
}): CollectionTemplate {
  const reference = input.invoiceNumber || "faktúre";
  return template(
    `FAKTURIO: potrebujeme ešte doplniť údaje k ${reference}`,
    [
      "Dobrý deň,",
      "",
      "ďakujeme za odpoveď. Na dokončenie spracovania ešte potrebujeme tieto údaje:",
      ...input.stillMissing.map((field) => `- ${field}`),
      "",
      "Prosíme, odpovedzte priamo na tento email.",
      input.dashboardUrl ? `Prípad v dashboarde: ${input.dashboardUrl}` : "",
      "",
      "Ďakujeme."
    ].filter((line) => line !== "")
  );
}

export function buildCustomerAmbiguousCaseFollowUp(input: {
  matchedAddress: string | null;
}): CollectionTemplate {
  return template(
    "FAKTURIO: potrebujeme identifikovať prípad",
    [
      "Dobrý deň,",
      "",
      "vašu správu sme prijali, ale nevieme ju jednoznačne priradiť ku konkrétnej faktúre.",
      "Prosíme, pošlite číslo faktúry alebo názov dlžníka, ktorého sa správa týka.",
      input.matchedAddress ? `Doručené na adresu: ${input.matchedAddress}` : "",
      "",
      "Ďakujeme."
    ].filter(Boolean)
  );
}

export function buildCustomerActionNeedsConfirmation(input: {
  invoiceNumber: string | null;
  requestedAction: string;
  dashboardUrl?: string | null;
}): CollectionTemplate {
  const reference = input.invoiceNumber || "prípadu";
  return template(
    `FAKTURIO: akcia k ${reference} vyžaduje potvrdenie`,
    [
      "Dobrý deň,",
      "",
      "vašu požiadavku sme zaevidovali:",
      input.requestedAction,
      "",
      "Z bezpečnostných dôvodov ju automaticky nevykonáme z emailu.",
      "Prosíme, potvrďte akciu v dashboarde FAKTURIO.",
      input.dashboardUrl ? `Prípad v dashboarde: ${input.dashboardUrl}` : "",
      "",
      "Ďakujeme."
    ].filter((line) => line !== "")
  );
}

export function buildCustomerDebtorMessageBlocked(input: {
  invoiceNumber: string | null;
  requestedMessage: string;
  reason: string;
  dashboardUrl?: string | null;
}): CollectionTemplate {
  const reference = input.invoiceNumber || "prípadu";
  return template(
    `FAKTURIO: správu k ${reference} sme neodoslali`,
    [
      "Dobrý deň,",
      "",
      "správu dlžníkovi sme neodoslali automaticky.",
      "",
      "Požadované znenie:",
      `„${input.requestedMessage}“`,
      "",
      "Dôvod:",
      input.reason,
      "",
      "FAKTURIO môže odosielať iba schválené neutrálne výzvy a pripomienky. Pri textoch o súde, právnych následkoch alebo iných právnych krokoch je potrebná manuálna kontrola a schválené znenie.",
      "Môžete odpovedať napríklad: pošlite schválenú druhú pripomienku, alebo upravte text bez právnej hrozby.",
      input.dashboardUrl ? `Prípad v dashboarde: ${input.dashboardUrl}` : "",
      "",
      "Ďakujeme."
    ].filter((line) => line !== "")
  );
}

export function buildCustomerManualReviewEscalation(input: {
  invoiceNumber: string | null;
  summary: string;
  dashboardUrl?: string | null;
}): CollectionTemplate {
  const reference = input.invoiceNumber || "prípadu";
  return template(
    `FAKTURIO: správa k ${reference} vyžaduje kontrolu`,
    [
      "Dobrý deň,",
      "",
      "vašu správu sme zaevidovali, ale automaticky ju nespracujeme.",
      input.summary,
      "Prípad zostáva na manuálnej kontrole v aplikácii.",
      input.dashboardUrl ? `Prípad v dashboarde: ${input.dashboardUrl}` : "",
      "",
      "Ďakujeme."
    ].filter((line) => line !== "")
  );
}

export function buildCustomerCaseStatusReply(input: {
  invoiceNumber: string | null;
  status: string;
  amountTotal: number | null;
  currency: string | null;
  dueDate: string | null;
  debtorName: string | null;
  recentEvents?: string[];
  confirmUrl?: string | null;
  dashboardUrl?: string | null;
}): CollectionTemplate {
  const reference = input.invoiceNumber || "prípadu";
  const amount =
    input.amountTotal !== null
      ? formatEmailMoney(input.amountTotal, input.currency)
      : "nezadaná";
  const dueDate = input.dueDate ? formatEmailDate(input.dueDate) : "nezadaná";
  const invoiceData: InvoiceEmailSummary = {
    invoiceNumber: input.invoiceNumber,
    debtorName: input.debtorName,
    amountTotal: input.amountTotal,
    currency: input.currency,
    dueDate: input.dueDate
  };
  return template(
    `FAKTURIO: stav ${reference}`,
    [
      "Dobrý deň,",
      "",
      `Aktuálny stav: ${input.status}`,
      `Faktúra: ${input.invoiceNumber || "nezadaná"}`,
      `Dlžník: ${input.debtorName || "nezadaný"}`,
      `Suma: ${amount}`,
      `Splatnosť: ${dueDate}`,
      ...(input.recentEvents?.length
        ? ["", "Posledné kroky:", ...input.recentEvents.map((event) => `- ${event}`)]
        : []),
      input.confirmUrl
        ? `Ak sú údaje správne, potvrďte spustenie kontroly tu: ${input.confirmUrl}`
        : "",
      input.dashboardUrl ? `Prípad v dashboarde: ${input.dashboardUrl}` : "",
      "",
      "Ďakujeme."
    ].filter((line) => line !== ""),
    {
      afterParagraph: 1,
      bodyHtml: renderInvoiceSummaryTable(invoiceData),
      skipHtmlPrefixes: [
        "Faktúra:",
        "Dlžník:",
        "Suma:",
        "Splatnosť:"
      ]
    }
  );
}

function template(
  subject: string,
  lines: string[],
  options?: { afterParagraph?: number; bodyHtml?: string; skipHtmlPrefixes?: string[] }
): CollectionTemplate {
  const textBody = lines.join("\n");
  let paragraphIndex = 0;
  const bodyHtml = lines
    .map((line) => {
      if (!line) {
        return "<br />";
      }
      if (options?.skipHtmlPrefixes?.some((prefix) => line.startsWith(prefix))) {
        return "";
      }
      const paragraph = `<p>${escapeHtml(line)}</p>`;
      paragraphIndex += 1;
      if (options?.bodyHtml && paragraphIndex === options.afterParagraph) {
        return `${paragraph}${options.bodyHtml}`;
      }
      return paragraph;
    })
    .join("");
  const preheader = lines.find((line) => line.trim().length > 0) ?? subject;
  const htmlBody = renderEmailDocument({ title: subject, preheader, bodyHtml });
  return { subject, textBody, htmlBody };
}

function invoiceSummaryTextLines(input: InvoiceEmailSummary): string[] {
  return invoiceSummaryRows(input).map((row) => `- ${row.label}: ${row.value}`);
}

function invoiceSummaryRows(input: InvoiceEmailSummary): Array<{
  label: string;
  value: string;
  missingKey?: string;
}> {
  const amount =
    input.amountTotal !== null && input.amountTotal !== undefined
      ? formatEmailMoney(input.amountTotal, input.currency)
      : "nezadaná";
  const dueDate = input.dueDate ? formatEmailDate(input.dueDate) : "nezadaná";
  return [
    { label: "Dokument", value: input.sourceDocumentName || "nezadaný" },
    { label: "Číslo faktúry", value: input.invoiceNumber || "nezadané", missingKey: "invoiceNumber" },
    { label: "Dodávateľ", value: input.supplierName || "nezadaný" },
    { label: "Odberateľ", value: input.debtorName || "nezadaný", missingKey: "debtorName" },
    { label: "Suma", value: amount, missingKey: "amountTotal" },
    { label: "Splatnosť", value: dueDate, missingKey: "dueDate" },
    { label: "IBAN", value: input.iban || "nezadaný" },
    { label: "Variabilný symbol", value: input.variableSymbol || "nezadaný" }
  ];
}

function renderInvoiceSummaryTable(
  input: InvoiceEmailSummary,
  missingFields: string[] = []
): string {
  const missingText = missingFields.join(" ").toLocaleLowerCase("sk");
  const isMissing = (row: { missingKey?: string; value: string }) => {
    if (!row.missingKey || !row.value.startsWith("nezadan")) {
      return false;
    }
    if (row.missingKey === "invoiceNumber") {
      return missingText.includes("číslo") || missingText.includes("cislo");
    }
    if (row.missingKey === "debtorName") {
      return missingText.includes("odberateľ") || missingText.includes("dlžník") || missingText.includes("dlznik");
    }
    if (row.missingKey === "amountTotal") {
      return missingText.includes("suma") || missingText.includes("úhradu") || missingText.includes("uhradu");
    }
    if (row.missingKey === "dueDate") {
      return missingText.includes("splat");
    }
    return false;
  };
  const rows = invoiceSummaryRows(input)
    .map((row) => {
      const missing = isMissing(row);
      const valueStyle = missing ? "color:#8a4b00;font-weight:700" : "color:#1d1d1b;font-weight:700";
      const rowStyle = missing ? "background:#fff7e8" : "background:#ffffff";
      return [
        `<tr style="${rowStyle}">`,
        `<td style="border:1px solid #d9ddd5;padding:8px 10px;color:#5d6661;width:38%">${escapeHtml(row.label)}</td>`,
        `<td style="border:1px solid #d9ddd5;padding:8px 10px;${valueStyle}">${escapeHtml(row.value)}</td>`,
        "</tr>"
      ].join("");
    })
    .join("");
  return [
    '<div style="margin:18px 0">',
    '<p style="margin:0 0 8px;font-weight:700">Načítané údaje z faktúry</p>',
    '<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="border-collapse:collapse;font-size:14px">',
    rows,
    "</table>",
    "</div>"
  ].join("");
}

function renderMissingFieldsBox(missingFields: string[]): string {
  if (missingFields.length === 0) {
    return "";
  }
  return [
    '<div style="margin:18px 0;padding:12px 14px;border:1px solid #e6a23c;background:#fff7e8">',
    '<p style="margin:0 0 8px;color:#7a3f00;font-weight:700">Chýbajúce povinné údaje</p>',
    '<ul style="margin:0;padding-left:20px;color:#7a3f00">',
    ...missingFields.map((field) => `<li>${escapeHtml(field)}</li>`),
    "</ul>",
    "</div>"
  ].join("");
}
