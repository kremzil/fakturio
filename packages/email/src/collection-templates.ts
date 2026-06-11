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
      `${payment.sequence}. splátka: ${payment.amount.toFixed(2)} ${input.currency}, splatná ${payment.dueDate}`
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
          `${payment.sequence}. splátka: ${payment.amount.toFixed(2)} ${input.currency}, splatná ${payment.dueDate}`
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
      `napriek predchádzajúcej upomienke eviduje ${input.creditorName} faktúru ${input.invoiceNumber} vo výške ${input.amountTotal.toFixed(2)} ${input.currency} ako neuhradenú.`,
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
      `veriteľ nepotvrdil prijatie ${input.missedSequence}. splátky vo výške ${input.missedAmount.toFixed(2)} ${input.currency}.`,
      "Splátkový kalendár preto evidujeme ako porušený.",
      `Prosíme o bezodkladné kontaktovanie FAKTURIO alebo veriteľa a vyriešenie zostávajúcej sumy ${input.remainingAmount.toFixed(2)} ${input.currency}.`,
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

function template(subject: string, lines: string[]): CollectionTemplate {
  const textBody = lines.join("\n");
  const htmlBody = lines
    .map((line) => (line ? `<p>${escapeHtml(line)}</p>` : "<br />"))
    .join("");
  return { subject, textBody, htmlBody };
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
