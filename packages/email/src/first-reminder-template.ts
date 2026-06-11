export type FirstReminderTemplateInput = {
  debtorName: string;
  creditorName: string;
  creditorAddress?: string | null;
  creditorIco?: string | null;
  invoiceNumber: string;
  amountTotal: number;
  currency: string;
  originalDueDate: string;
  requestedPaymentDate: string;
  iban?: string | null;
  variableSymbol?: string | null;
  subjectNote?: string | null;
};

export type EmailTemplate = {
  subject: string;
  textBody: string;
  htmlBody: string;
};

export function buildFirstReminderEmail(
  input: FirstReminderTemplateInput
): EmailTemplate {
  const amount = `${input.amountTotal.toFixed(2)} ${input.currency}`;
  const paymentRows = [
    input.iban ? `IBAN: ${input.iban}` : null,
    input.variableSymbol
      ? `Variabilný symbol: ${input.variableSymbol}`
      : null
  ].filter((value): value is string => Boolean(value));
  const creditorRows = [
    input.creditorAddress ? `Adresa veriteľa: ${input.creditorAddress}` : null,
    input.creditorIco ? `IČO veriteľa: ${input.creditorIco}` : null
  ].filter((value): value is string => Boolean(value));

  const subject = `Pripomienka úhrady faktúry ${input.invoiceNumber}`;
  const textBody = [
    `Dobrý deň, ${input.debtorName},`,
    "",
    `v mene spoločnosti ${input.creditorName} si Vás dovoľujeme upozorniť, že evidujeme neuhradenú faktúru ${input.invoiceNumber}.`,
    `Suma na úhradu: ${amount}`,
    `Pôvodný dátum splatnosti: ${input.originalDueDate}`,
    ...creditorRows,
    ...(input.subjectNote ? [`Predmet faktúry: ${input.subjectNote}`] : []),
    ...paymentRows,
    "",
    `Prosíme o úhradu najneskôr do ${input.requestedPaymentDate}.`,
    "Ak ste už faktúru uhradili, odpovedzte na tento email s informáciou o platbe.",
    "",
    "Ďakujeme."
  ].join("\n");

  const detailRows = [
    ["Veriteľ", input.creditorName],
    ["Faktúra", input.invoiceNumber],
    ["Suma na úhradu", amount],
    ["Pôvodná splatnosť", input.originalDueDate],
    ["Nový termín úhrady", input.requestedPaymentDate],
    ...(input.creditorAddress
      ? [["Adresa veriteľa", input.creditorAddress] as const]
      : []),
    ...(input.creditorIco
      ? [["IČO veriteľa", input.creditorIco] as const]
      : []),
    ...(input.subjectNote
      ? [["Predmet faktúry", input.subjectNote] as const]
      : []),
    ...(input.iban ? [["IBAN", input.iban] as const] : []),
    ...(input.variableSymbol
      ? [["Variabilný symbol", input.variableSymbol] as const]
      : [])
  ];

  const htmlBody = [
    `<p>Dobrý deň, ${escapeHtml(input.debtorName)},</p>`,
    `<p>v mene spoločnosti <strong>${escapeHtml(input.creditorName)}</strong> si Vás dovoľujeme upozorniť, že evidujeme neuhradenú faktúru.</p>`,
    `<table style="border-collapse:collapse;margin:16px 0">${detailRows
      .map(
        ([label, value]) =>
          `<tr><td style="padding:3px 16px 3px 0;color:#666">${escapeHtml(label)}</td><td style="padding:3px 0"><strong>${escapeHtml(value)}</strong></td></tr>`
      )
      .join("")}</table>`,
    `<p>Prosíme o úhradu najneskôr do <strong>${escapeHtml(input.requestedPaymentDate)}</strong>.</p>`,
    "<p>Ak ste už faktúru uhradili, odpovedzte na tento email s informáciou o platbe.</p>",
    "<p>Ďakujeme.</p>"
  ].join("");

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
