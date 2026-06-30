const currencySymbols: Record<string, string> = {
  EUR: "€"
};

export function formatEmailMoney(
  amount: number,
  currency: string | null | undefined
): string {
  const normalizedCurrency = (currency || "EUR").toUpperCase();
  const formattedAmount = new Intl.NumberFormat("sk-SK", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  }).format(amount);
  return `${formattedAmount} ${currencySymbols[normalizedCurrency] ?? normalizedCurrency}`;
}

export function formatEmailDate(value: string | Date): string {
  const date =
    typeof value === "string" ? new Date(`${value.slice(0, 10)}T00:00:00.000Z`) : value;
  if (Number.isNaN(date.getTime())) {
    return typeof value === "string" ? value : "";
  }
  return new Intl.DateTimeFormat("sk-SK", {
    day: "numeric",
    month: "numeric",
    year: "numeric",
    timeZone: "UTC"
  }).format(date);
}

export function renderEmailDocument(input: {
  title: string;
  preheader: string;
  bodyHtml: string;
}): string {
  return [
    '<!doctype html>',
    '<html lang="sk">',
    '<head>',
    '<meta charset="utf-8" />',
    '<meta name="viewport" content="width=device-width, initial-scale=1" />',
    `<title>${escapeHtml(input.title)}</title>`,
    "</head>",
    '<body style="margin:0;background:#f3f5f1;color:#1d1d1b;font-family:Arial,sans-serif;line-height:1.5">',
    `<div style="display:none;max-height:0;overflow:hidden;opacity:0">${escapeHtml(input.preheader)}</div>`,
    '<div style="max-width:640px;margin:0 auto;padding:24px 16px">',
    '<div style="background:#ffffff;border:1px solid #d9ddd5;padding:24px">',
    input.bodyHtml,
    "</div>",
    "</div>",
    "</body>",
    "</html>"
  ].join("");
}

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
