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
  missingFields: string[];
  warnings: string[];
}): CollectionTemplate {
  const reference = input.invoiceNumber || "novej faktúre";
  const missing =
    input.missingFields.length > 0
      ? input.missingFields
      : ["údaje označené v aplikácii ako nejasné"];
  const warningLines =
    input.warnings.length > 0
      ? ["", "Poznámky z automatického spracovania:", ...input.warnings.map((item) => `- ${item}`)]
      : [];

  return template(
    `FAKTURIO: potrebujeme doplniť údaje k ${reference}`,
    [
      "Dobrý deň,",
      "",
      `pri spracovaní ${reference} sa nepodarilo spoľahlivo načítať všetky údaje potrebné na založenie prípadu.`,
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
    ]
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
    ].filter((line) => line !== "")
  );
}

function template(subject: string, lines: string[]): CollectionTemplate {
  const textBody = lines.join("\n");
  const bodyHtml = lines
    .map((line) => (line ? `<p>${escapeHtml(line)}</p>` : "<br />"))
    .join("");
  const preheader = lines.find((line) => line.trim().length > 0) ?? subject;
  const htmlBody = renderEmailDocument({ title: subject, preheader, bodyHtml });
  return { subject, textBody, htmlBody };
}
