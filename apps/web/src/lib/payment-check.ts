import {
  CASE_EVENT_TYPES,
  type CaseStatus,
  type PaymentCheckAction,
  requirePaymentCheckTokenSecret,
  resolvePaymentCheckTransition,
  verifyPaymentCheckToken
} from "@fakturio/shared";
import { prisma } from "@fakturio/db";

/**
 * Public, token-authorized payment-check flow used from links inside customer emails.
 *
 * These routes are intentionally NOT session-protected: the recipient of the email may not
 * have an active dashboard session. Authorization comes solely from a signed HMAC token bound
 * to { caseId, organizationId, action, expiresAt }.
 *
 * Safety properties:
 *  - GET only renders a landing page and never mutates state (safe against email scanners,
 *    link prefetchers and SafeLinks that auto-issue GET requests).
 *  - POST re-verifies the token and applies the transition atomically.
 *  - Replay safety is state-based idempotency (see resolvePaymentCheckTransition), not a nonce.
 */

const NO_STORE_HEADERS = {
  "Content-Type": "text/html; charset=utf-8",
  "Cache-Control": "no-store, max-age=0",
  "Referrer-Policy": "no-referrer"
} as const;

type CaseSummary = {
  invoiceNumber: string | null;
  amountTotal: number | null;
  currency: string | null;
  debtorName: string | null;
  dueDate: string | null;
  status: CaseStatus;
};

const ACTION_COPY: Record<
  PaymentCheckAction,
  { landingTitle: string; landingLead: string; submitLabel: string; appliedTitle: string; appliedMessage: string; noopMessage: string }
> = {
  PAID: {
    landingTitle: "Potvrdenie úhrady",
    landingLead: "Potvrďte, že platba za túto faktúru bola prijatá. Prípad sa uzavrie ako uhradený.",
    submitLabel: "Potvrdiť úhradu",
    appliedTitle: "Platba potvrdená",
    appliedMessage: "Prípad bol uzavretý ako uhradený.",
    noopMessage: "Prípad už bol uzavretý ako uhradený."
  },
  NOT_PAID: {
    landingTitle: "Platba neprišla",
    landingLead: "Potvrďte, že platba zatiaľ neprišla. Prípad sa označí ako po splatnosti a môže pokračovať ďalšími krokmi.",
    submitLabel: "Potvrdiť, že platba neprišla",
    appliedTitle: "Označené ako po splatnosti",
    appliedMessage: "Prípad bol označený ako po splatnosti. FAKTURIO môže pokračovať ďalšími krokmi.",
    noopMessage: "Prípad je už označený ako po splatnosti."
  }
};

function verifyToken(token: string | null, caseId: string, action: PaymentCheckAction) {
  if (!token) {
    return { ok: false as const, reason: "MALFORMED" as const };
  }
  const secret = requirePaymentCheckTokenSecret();
  return verifyPaymentCheckToken(token, secret, { expectedCaseId: caseId, expectedAction: action });
}

async function loadCaseSummary(caseId: string, organizationId: string): Promise<CaseSummary | null> {
  const found = await prisma.case.findFirst({
    where: { id: caseId, organizationId },
    include: { debtor: true }
  });

  if (!found) {
    return null;
  }

  return {
    invoiceNumber: found.invoiceNumber,
    amountTotal: found.amountTotal ? Number(found.amountTotal) : null,
    currency: found.currency,
    debtorName: found.debtor?.name ?? null,
    dueDate: found.dueDate?.toISOString().slice(0, 10) ?? null,
    status: found.status as CaseStatus
  };
}

type ApplyResult =
  | { outcome: "APPLIED"; status: CaseStatus }
  | { outcome: "NOOP"; status: CaseStatus }
  | { outcome: "CONFLICT"; status: CaseStatus; reason: string }
  | { outcome: "NOT_FOUND" };

async function applyPaymentCheck(caseId: string, organizationId: string, action: PaymentCheckAction): Promise<ApplyResult> {
  // Optimistic concurrency: two concurrent POSTs (e.g. PAID and NOT_PAID) could both read the
  // same status and then clobber each other. We guard every write with `status` in the WHERE
  // clause so a writer only applies the transition it actually resolved from; if a concurrent
  // commit changed the status first, the conditional update matches 0 rows and we re-resolve.
  const MAX_ATTEMPTS = 3;

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    const result = await prisma.$transaction(async (tx) => {
      const existing = await tx.case.findFirst({
        where: { id: caseId, organizationId },
        select: { status: true }
      });

      if (!existing) {
        return { outcome: "NOT_FOUND" } as const;
      }

      const currentStatus = existing.status as CaseStatus;
      const transition = resolvePaymentCheckTransition(action, currentStatus);

      if (transition.outcome === "NOOP") {
        return { outcome: "NOOP", status: currentStatus } as const;
      }

      if (transition.outcome === "CONFLICT") {
        return { outcome: "CONFLICT", status: currentStatus, reason: transition.reason } as const;
      }

      const changed = await tx.case.updateMany({
        where: { id: caseId, organizationId, status: currentStatus },
        data: scalarMutationForAction(action, transition.nextStatus)
      });

      if (changed.count === 0) {
        // Status moved under us between the read and the write — retry with a fresh read.
        return { outcome: "RETRY" } as const;
      }

      await tx.caseEvent.createMany({ data: eventsForAction(caseId, action) });

      return { outcome: "APPLIED", status: transition.nextStatus } as const;
    });

    if (result.outcome !== "RETRY") {
      return result;
    }
  }

  // Exhausted retries under sustained contention: report a conflict rather than guessing.
  return {
    outcome: "CONFLICT",
    status: (await loadCaseStatus(caseId, organizationId)) ?? "RECEIVED",
    reason: "Case was updated concurrently. Please reload and try again."
  };
}

async function loadCaseStatus(caseId: string, organizationId: string): Promise<CaseStatus | null> {
  const found = await prisma.case.findFirst({
    where: { id: caseId, organizationId },
    select: { status: true }
  });
  return (found?.status as CaseStatus | undefined) ?? null;
}

function scalarMutationForAction(action: PaymentCheckAction, nextStatus: CaseStatus) {
  if (action === "PAID") {
    return { status: nextStatus, closedAt: new Date() };
  }
  return { status: nextStatus };
}

function eventsForAction(caseId: string, action: PaymentCheckAction) {
  if (action === "PAID") {
    return [
      {
        caseId,
        actorType: "USER" as const,
        type: CASE_EVENT_TYPES.paymentReceivedConfirmed,
        note: "Customer confirmed that payment was received from the payment-check email."
      }
    ];
  }

  return [
    {
      caseId,
      actorType: "USER" as const,
      type: CASE_EVENT_TYPES.paymentNotReceivedConfirmed,
      note: "Customer confirmed from the payment-check email that payment was not received."
    },
    {
      caseId,
      actorType: "WORKFLOW" as const,
      type: CASE_EVENT_TYPES.workflowWaiting,
      note: "Case is overdue. Next collection steps can start."
    }
  ];
}

export async function handlePaymentCheckGet(
  request: Request,
  caseId: string,
  action: PaymentCheckAction
): Promise<Response> {
  const token = new URL(request.url).searchParams.get("token");
  const verification = verifyToken(token, caseId, action);

  if (!verification.ok) {
    return page(invalidTokenTitle(verification.reason), invalidTokenMessage(verification.reason), 400);
  }

  const summary = await loadCaseSummary(caseId, verification.claims.organizationId);
  if (!summary) {
    return page("Prípad neexistuje", "Tento prípad sa nenašiel.", 404);
  }

  const copy = ACTION_COPY[action];
  const body = `
    <p>${escapeHtml(copy.landingLead)}</p>
    ${summaryHtml(summary)}
    <form method="post" action="${escapeHtml(`?token=${token}`)}">
      <button type="submit" style="display:inline-block;padding:10px 16px;background:#1d1d1b;color:#fff;border:none;border-radius:6px;cursor:pointer;font-size:15px">${escapeHtml(
        copy.submitLabel
      )}</button>
    </form>`;

  return page(copy.landingTitle, body, 200);
}

export async function handlePaymentCheckPost(
  request: Request,
  caseId: string,
  action: PaymentCheckAction
): Promise<Response> {
  const token = new URL(request.url).searchParams.get("token");
  const verification = verifyToken(token, caseId, action);

  if (!verification.ok) {
    return page(invalidTokenTitle(verification.reason), invalidTokenMessage(verification.reason), 400);
  }

  const result = await applyPaymentCheck(caseId, verification.claims.organizationId, action);
  const copy = ACTION_COPY[action];

  switch (result.outcome) {
    case "NOT_FOUND":
      return page("Prípad neexistuje", "Tento prípad sa nenašiel.", 404);
    case "CONFLICT":
      return page("Akciu nie je možné vykonať", escapeHtml(result.reason), 409);
    case "NOOP":
      return page(copy.appliedTitle, escapeHtml(copy.noopMessage), 200);
    case "APPLIED":
    default:
      return page(copy.appliedTitle, escapeHtml(copy.appliedMessage), 200);
  }
}

function summaryHtml(summary: CaseSummary): string {
  const amount =
    summary.amountTotal !== null ? `${summary.amountTotal.toFixed(2)} ${summary.currency ?? ""}`.trim() : "nezistená suma";
  return `
    <table style="border-collapse:collapse;margin:16px 0">
      <tr><td style="padding:2px 12px 2px 0;color:#666">Faktúra</td><td>${escapeHtml(summary.invoiceNumber ?? "—")}</td></tr>
      <tr><td style="padding:2px 12px 2px 0;color:#666">Odberateľ</td><td>${escapeHtml(summary.debtorName ?? "—")}</td></tr>
      <tr><td style="padding:2px 12px 2px 0;color:#666">Suma</td><td>${escapeHtml(amount)}</td></tr>
      <tr><td style="padding:2px 12px 2px 0;color:#666">Splatnosť</td><td>${escapeHtml(summary.dueDate ?? "—")}</td></tr>
    </table>`;
}

function invalidTokenTitle(reason: string): string {
  return reason === "EXPIRED" ? "Odkaz expiroval" : "Neplatný odkaz";
}

function invalidTokenMessage(reason: string): string {
  if (reason === "EXPIRED") {
    return "Platnosť tohto odkazu uplynula. Otvorte FAKTURIO a aktualizujte stav prípadu manuálne.";
  }
  return "Tento odkaz nie je platný. Otvorte FAKTURIO a aktualizujte stav prípadu manuálne.";
}

function page(title: string, bodyHtml: string, status: number): Response {
  return new Response(
    `<!doctype html><html lang="sk"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="referrer" content="no-referrer"><title>${escapeHtml(
      title
    )}</title><style>body{font-family:Arial,sans-serif;margin:48px;color:#1d1d1b;max-width:560px}a{color:#1d1d1b}</style></head><body><h1>${escapeHtml(
      title
    )}</h1>${bodyHtml}<p style="margin-top:24px"><a href="/">Späť do FAKTURIO</a></p></body></html>`,
    { status, headers: NO_STORE_HEADERS }
  );
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
